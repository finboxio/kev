const v8 = require('v8')
const { URL } = require('url')
const Redis = require('ioredis')
const Stream = require('redis-stream')
const transform = require('stream-transform')

const debug = require('debug')('kev:plugin:redis')

const STATICS = {
  watch: 'WATCH',
  multi: 'MULTI',
  echo: 'ECHO',
  next: 'NEXT',
  done: 'DONE',
  get: 'GET',
  set: 'SET',
  eval: 'EVAL',
  unlink: 'UNLINK',
  sadd: 'SADD',
  exec: 'EXEC',
  px: 'px',
  truthy: '1',
  script: 'local members = redis.call("smembers", KEYS[1]); if #members > 0 then return redis.call("unlink", unpack(members)) else return 0 end'
}

module.exports = class KevRedis {
  constructor (url, options = {}) {
    const parsed = new URL(url)
    this.client = new Redis(url, options)
    this.stream = new Stream(parsed.port, parsed.hostname)
  }

  async get (keys = []) {
    const result = await this.client.mget(keys)
    return result.map((value) => {
      if (value) return unpack(value)
    })
  }

  async set (keyvalues = []) {
    const priors = {}
    const _set = (keyvalues) => {
      let i = 0
      let previous = null
      let collect = false
      const retry = []
      const stream = this.stream.stream()
      stream.on('data', (data) => {
        if (data === STATICS.done) stream.end()
        else if (data === STATICS.next) collect = true
        else if (previous === 'QUEUED' && ![ 'QUEUED', STATICS.next ].includes(data)) {
          // Exec failed
          const keyvalue = keyvalues[i++]
          retry.push(keyvalue)
          priors[keyvalue.key] = undefined
        } else if (collect) {
          // Get previous value
          const keyvalue = keyvalues[i++]
          collect = false
          if (data === '-1') {
            priors[keyvalue.key] = undefined
          } else {
            try {
              priors[keyvalue.key] = unpack(data)
            } catch (e) {
              debug('failed to unpack data', { data, ...keyvalue })
              priors[keyvalue.key] = undefined
            }
          }
        }

        previous = data
      })

      const cmds = []
      keyvalues.forEach((keyvalue) => {
        let { key, value, ttl, tags = [] } = keyvalue
        const expire = ttl ? [ STATICS.px, ttl ] : []

        value = pack(value)

        const key_tags = keyTagsKey(key)
        const cmd = [
          [ STATICS.watch, key, key_tags ],
          [ STATICS.multi ],
          [ STATICS.echo, STATICS.next ],
          [ STATICS.get, key ],
          [ STATICS.set, key, value, ...expire ],
          [ STATICS.eval, STATICS.script, 1, key_tags ],
          [ STATICS.unlink, key_tags ]
        ]

        if (tags.length) {
          const tag_keys = tags.map(keyTagKey(key))
          tag_keys.forEach((tag) => cmd.push([ STATICS.set, tag, STATICS.truthy, ...expire ]))
          cmd.push([ STATICS.sadd, key_tags, ...tag_keys ])
        }

        cmd.push([ STATICS.exec ])

        cmd.map((c) => Stream.parse(c)).forEach((c) => stream.redis.write(c))
      })

      stream.redis.write(Stream.parse([ STATICS.echo, STATICS.done ]))

      return new Promise((resolve, reject) => {
        stream.on('close', () => resolve({ retry }))
        stream.on('error', (e) => reject(e))
      })
    }

    let kvs = keyvalues
    while (kvs.length) {
      const { retry } = await _set(kvs)
      kvs = retry
      kvs.forEach((kv) => debug('retrying', kv.key))
    }

    return keyvalues.map(({ key }) => priors[key])
  }

  async del (keys = []) {
    let cmd = this.client.multi().mget(keys)

    cmd = keys.reduce((cmd, key) => cmd.unlink(key), cmd)

    const script = STATICS.script
    cmd = keys.reduce((cmd, key) => cmd.eval(script, 1, keyTagsKey(key)), cmd)

    cmd = cmd.unlink(keys.map(keyTagsKey))

    const result = await cmd.exec()

    const [ [ , values ], ...rest ] = result
    const deleted = rest.slice(0, keys.length)
    return deleted.map((count, i) => {
      if (!count) return
      if (!values[i]) return
      return unpack(values[i])
    })
  }

  async tags (keys = []) {
    const cmd = keys.reduce((cmd, key) => cmd.smembers(keyTagsKey(key)), this.client.pipeline())
    const result = await cmd.exec()
    return result.map(([ , members ]) => members
      .map((key) => key.replace(new RegExp(`^${TAG_KEY_PREFIX}:`), ''))
      .map((key) => key.split(':')[0])
      .map((key) => debase64(key)))
  }

  async dropKeys (globs = []) {
    const results = []
    const promises = []

    globs.forEach((glob, i) => {
      results[i] = 0
      const stream = this.keys(glob)
      stream.on('data', (key) => results[i]++)
      stream.on('data', (key) => promises.push(this.del([ key ])))
      promises.push(until(stream, 'end'))
    })

    return Promise.all(promises).then(() => results)
  }

  async dropTags (tags = []) {
    const results = []
    const promises = []

    tags.forEach((tag, i) => {
      results[i] = 0
      const stream = this.tagged(tag)
      stream.on('data', (key) => results[i]++)
      stream.on('data', (key) => promises.push(this.del([ key ])))
      promises.push(until(stream, 'end'))
    })

    await Promise.all(promises)

    return results
  }

  tagged (tag) {
    const prefix = `${tagKey(tag)}:`
    const stream = this.client.scanStream({ match: `${prefix}*` })
    return stream
      .pipe(transform((keys, done) => setImmediate(() => done(null, ...keys))))
      .pipe(transform((key) => key.replace(prefix, '')))
      .pipe(transform((key) => debase64(key)))
  }

  keys (glob) {
    const stream = this.client.scanStream({ match: glob })
    return stream
      .pipe(transform((keys, done) => setImmediate(() => done(null, ...keys))))
  }

  async close () {
    this.client.quit()
  }
}

const until = (emitter, event) => {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve)
  })
}

/**
 * In order to ensure that the tagsKey and all of its member tagKeys
 * are stored on the same node (which is required for the eval script
 * we use to achieve atomic sets/dels), we make use of hash tags. To
 * ensure unique hash slots per key, we escape any right curly brackets
 * that may be included in the key or tag itself.
 *
 * Read more here: https://redis.io/topics/cluster-spec
 */
const TAG_KEY_PREFIX = '__tagged__'
const KEY_TAGS_PREFIX = '__tags__'
const tagKey = (tag) => `${TAG_KEY_PREFIX}:${base64(tag)}`
const keyTagsKey = (key) => `${KEY_TAGS_PREFIX}:{${base64(key)}}`
const keyTagKey = (key) => (tag) => `${tagKey(tag)}:{${base64(key)}}`
const base64 = (str) => Buffer.from(str).toString('base64')
const debase64 = (str) => Buffer.from(str, 'base64').toString('utf8')

const pack = (value) => {
  let vtype = 0
  if (value instanceof Buffer) {
    vtype = 1
    value = value.toString('hex')
  } else if (typeof value !== 'string') {
    vtype = 2
    value = v8.serialize(value).toString('hex')
  }
  return String(vtype) + value
}

const unpack = (value) => {
  const vtype = parseInt(value[0])
  value = value.slice(1)
  if (vtype === 1) {
    value = Buffer.from(value, 'hex')
  } else if (vtype === 2) {
    value = v8.deserialize(Buffer.from(value, 'hex'))
  }
  return value
}
