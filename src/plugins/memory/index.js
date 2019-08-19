const stream = require('into-stream')
const globber = require('glob-to-regexp')
const LRU = require('lru-cache')
const Bytes = require('bytes')
const v8 = require('v8')

const storage = {}
const tagged_keys = {}

module.exports = class KevMemory {
  constructor (url, { max_memory = 0 } = {}) {
    let max = 0

    max_memory = String(max_memory).trim()
    if (max_memory.endsWith('b')) {
      max = Bytes.parse(max_memory) / 8
    } else {
      max = Bytes.parse(max_memory)
    }

    storage[url] = storage[url] || new LRU({
      max,
      length: ({ value, tags = [] }, key) => {
        const keylen = Buffer.from(key).length
        const taglen = tags.reduce((sum, tag) => {
          return sum + Buffer.concat([
            Buffer.from(tag), // Tag is stored in the main cache
            Buffer.from(key), // Key is stored in the tag cache
            v8.serialize(true) // Bool is stored in the tag cache
          ]).length
        }, 0)

        let vallen
        if (value instanceof Buffer) vallen = value.length
        else if (typeof value === 'string') vallen = Buffer.from(value).length
        else vallen = v8.serialize(value).length

        const len = keylen + taglen + vallen
        return len
      }
    })

    tagged_keys[url] = tagged_keys[url] || {}
    this.storage = storage[url]
    this.tagged_keys = tagged_keys[url]
  }

  async get (keys = []) {
    return keys
      .map((key) => this.storage.get(key))
      .map(({ value } = {}) => value)
  }

  async set (keyvalues = []) {
    return keyvalues.map(({ key, value, ttl, tags = [] }) => {
      const { value: original } = this.storage.peek(key) || {}
      this.del([ key ])
      this.storage.set(key, { value, tags }, ttl)
      tags.forEach((tag) => {
        this.tagged_keys[tag] = this.tagged_keys[tag] || new LRU({ max: 0 })
        this.tagged_keys[tag].set(key, true, ttl)
      })
      return original
    })
  }

  async del (keys = []) {
    return keys.map((key) => {
      const stored = this.storage.peek(key)
      if (!stored) return

      const { value, tags = [] } = stored
      this.storage.del(key)
      tags.forEach((tag) => {
        this.tagged_keys[tag].del(key)
        this.tagged_keys[tag].prune()
        if (!this.tagged_keys[tag].itemCount) {
          delete this.tagged_keys[tag]
        }
      })

      return value
    })
  }

  async tags (keys = []) {
    return keys.map((key) => {
      const { tags = [] } = this.storage.peek(key) || {}
      return tags
    })
  }

  async dropKeys (patterns = []) {
    return Promise.all(patterns
      .map((p) => globber(p))
      .map((regexp) => this.storage.keys().filter((key) => key.match(regexp)))
      .map((deletes) => this.del(deletes).then((deleted) => deleted.length)))
  }

  async dropTags (tags = []) {
    return Promise.all(tags
      .map((tag) => this.tagged_keys[tag])
      .filter(Boolean)
      .map((cache) => cache.keys())
      .map((deletes) => this.del(deletes).then((deleted) => deleted.length)))
  }

  tagged (tag) {
    if (!this.tagged_keys[tag]) return stream.object([])

    this.tagged_keys[tag].prune()
    const matches = this.tagged_keys[tag].keys()
    return stream.object(matches)
  }

  keys (pattern) {
    this.storage.prune()
    const matches = this.storage.keys().filter((k) => k.match(globber(pattern)))
    return stream.object(matches)
  }

  async close () {}
}
