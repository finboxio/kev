const zlib = require('zlib')
const v8 = require('v8')
const { promisify } = require('util')

const ms = require('ms')
const transform = require('stream-transform')
const read = require('stream-to-array')
const Resurrect = require('resurrect-js')

const Plugin = require('./plugins')

module.exports = class Kev {
  constructor ({ url, ttl, prefix = [], tags = [], compression = false, serializer, ...plugin_opts } = {}) {
    this.store = Plugin(url, plugin_opts)
    this.ttl = ttl
    this.prefix = Array.isArray(prefix) ? prefix : [ prefix ]
    this.default_tags = tags
    this.compression = compression
    this.serializer = {}
    const { pack, unpack } = serializer || {}
    let resurrector
    switch (serializer) {
      case 'v8':
        this.serializer.pack = v8.serialize.bind(v8)
        this.serializer.unpack = v8.deserialize.bind(v8)
        break
      case 'json':
        this.serializer.pack = JSON.stringify
        this.serializer.unpack = (data) => data && JSON.parse(data)
        break
      case 'resurrect':
        resurrector = new Resurrect({ prefix: '__kev#', cleanup: true })
        this.serializer.pack = resurrector.stringify.bind(resurrector)
        this.serializer.unpack = resurrector.resurrect.bind(resurrector)
        break
      case 'raw':
        this.serializer.pack = noop
        this.serializer.unpack = noop
        break
      default:
        this.serializer.pack = pack || this.store.pack || noop
        this.serializer.unpack = unpack || this.store.unpack || noop
    }
  }

  get opts () {
    return {
      ttl: this.ttl,
      prefix: this.prefix,
      tags: this.default_tags,
      compression: this.compression,
      serializer: this.serializer
    }
  }

  withPrefix (prefix) {
    prefix = this.prefix.concat(prefix)
    const clone = new Kev({ ...this.opts, prefix })
    clone.store = this.store
    return clone
  }

  // TODO: augment tags with parent prefixes as well
  withTags (tags) {
    tags = this.default_tags.concat(tags)
    const clone = new Kev({ ...this.opts, tags })
    clone.store = this.store
    return clone
  }

  withTTL (ttl) {
    const clone = new Kev({ ...this.opts, ttl })
    clone.store = this.store
    return clone
  }

  /** Get */

  async get (key, { decompress = true } = {}) {
    if (Array.isArray(key)) return this.getMany(key)

    key = this.prefixed(key)
    const result = await this.store.get.load(key)
    return this.unpack(result, { decompress })
  }

  async getMany (keys) {
    const values = await Promise.all(keys.map((k) => this.get(k)))
    return zip(keys, values)
  }

  /** Set */

  async set (key, value, { ttl, tags = [] } = {}) {
    if (typeof key === 'object') return this.setMany(key, value)

    key = this.prefixed(key)
    ttl = ms(String(ttl || this.ttl || 0))
    tags = prefixedTags(this.prefix, tags.concat(this.default_tags))
    value = await this.pack(value)

    const previous = await this.store.set.load({ key, value, ttl, tags })
    return this.unpack(previous)
  }

  async setMany (kvobj, { ttl, tags = [] } = {}) {
    const keys = Object.keys(kvobj)
    const values = await Promise.all(keys.map((key) => this.set(key, kvobj[key], { ttl, tags })))
    return zip(keys, values)
  }

  /** Del */

  async del (key) {
    if (Array.isArray(key)) return this.delMany(key)

    key = this.prefixed(key)

    const previous = await this.store.del.load(key)
    return this.unpack(previous)
  }

  async delMany (keys) {
    const values = await Promise.all(keys.map((k) => this.del(k)))
    return zip(keys, values)
  }

  /** Tags */

  async tags (key) {
    if (Array.isArray(key)) {
      const tags = await Promise.all(key.map((k) => this.tags(k)))
      return zip(key, tags)
    }

    key = this.prefixed(key)
    const tags = await this.store.tags.load(key)
    return tags
      .filter((tag) => tag.startsWith(this.prefixed()))
      .map(this.deprefixed.bind(this))
  }

  /** Key Streams */

  keys (pattern = '*') {
    pattern = this.prefixed(pattern)
    const stream = this.store.keys(pattern)
      .pipe(transform(this.deprefixed.bind(this)))
    stream.toArray = () => read(stream)
    return stream
  }

  tagged (tag) {
    tag = this.prefixed(tag)
    const stream = this.store.tagged(tag)
      .pipe(transform(this.deprefixed.bind(this)))
    stream.toArray = () => read(stream)
    return stream
  }

  /** Drop Keys */

  async dropKeys (pattern = '*') {
    if (Array.isArray(pattern)) {
      const dropped = await Promise.all(pattern.map((p) => this.dropKeys(p)))
      return zip(pattern, dropped)
    }
    pattern = this.prefixed(pattern)
    return this.store.dropKeys.load(pattern)
  }

  /** Drop Tags */

  async dropTag (tag) {
    if (Array.isArray(tag)) return this.dropTags(tag)

    tag = this.prefixed(tag)
    return this.store.dropTag.load(tag)
  }

  async dropTags (tags) {
    const dropped = await Promise.all(tags.map((t) => this.dropTag(t)))
    return zip(tags, dropped)
  }

  async close () {
    // Wait until next tick to close because loaders may have queued operations
    return new Promise((resolve, reject) => {
      process.nextTick(() => this.store.close().then(resolve).catch(reject))
    })
  }

  prefixed (key = '') {
    return this.prefix.concat([ key ]).join(':')
  }

  deprefixed (key) {
    return key.replace(new RegExp(`^${this.prefixed()}`), '')
  }

  async pack (value) {
    const packed = this.serializer.pack(value)
    if (!this.compression) {
      return packed
    } else {
      const compressed = await this.compress(packed)
      return compressed
    }
  }

  async unpack (value, { decompress = true } = {}) {
    if (value === undefined) return value
    if (!this.compression) return this.serializer.unpack(value)

    if (!decompress) {
      if (this.compression.encoding) {
        return Buffer
          .from(value, this.compression.encoding)
          .slice(1)
          .toString(this.compression.encoding)
      } else {
        const raw = value.slice(1)
        return raw
      }
    } else {
      const decompressed = await this.decompress(value)
      return this.serializer.unpack(decompressed)
    }
  }

  async compress (data) {
    const opts = this.compression
    const fn = {
      gzip: 'gzip',
      deflate: 'deflate',
      brotli: 'brotliCompress'
    }[opts.type]

    let compressible = data
    let serialization = 0
    if (typeof compressible === 'string') {
      serialization = 1
      compressible = Buffer.from(compressible)
    } else if (!(compressible instanceof Buffer)) {
      serialization = 2
      compressible = v8.serialize(compressible)
    }

    const compressed = await promisify(zlib[fn])(compressible, opts)
    const buffer = Buffer.concat([ Buffer.from([ serialization ]), compressed ])
    return opts.encoding ? buffer.toString(opts.encoding) : buffer
  }

  async decompress (data) {
    const opts = this.compression
    const fn = {
      gzip: 'gunzip',
      deflate: 'inflate',
      brotli: 'brotliDecompress'
    }[opts.type]

    if (opts.encoding) {
      data = Buffer.from(data, opts.encoding)
    }

    const serialization = data.readUInt8(0)
    const decompressible = data.slice(1)

    let decompressed = await promisify(zlib[fn])(decompressible, opts)
    if (serialization === 1) {
      decompressed = decompressed.toString()
    } else if (serialization === 2) {
      decompressed = v8.deserialize(decompressed)
    }

    return decompressed
  }
}

const prefixedTags = (prefixes, tags) => {
  return prefixes.reduce((prefixed, prefix, i, prefixes) => {
    prefixed.push(...tags.map((tag) => prefixes.slice(0, i + 1).concat(tag).join(':')))
    return prefixed
  }, [])
}

const zip = (keys, values) => {
  return keys.reduce((zipped, key, i) => {
    zipped[key] = values[i]
    return zipped
  }, {})
}

const noop = (v) => v
