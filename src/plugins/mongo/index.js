const { PassThrough } = require('stream')

const { MongoClient } = require('@fnbx/mongodb')
const globber = require('glob-to-regexp')
const transform = require('stream-transform')

module.exports = class KevMongo {
  constructor (url, { client, db, collection = 'kev', ...options } = {}) {
    this._collection_exists = false
    this.client = client || new MongoClient(url, { ...options, useNewUrlParser: true, useUnifiedTopology: true })
    this.collection = async () => {
      if (!this.client.isConnected()) {
        await this.client.connect()
      }

      const database = this.client.db(db)
      if (!this._collection_exists) {
        const collections = await database.listCollections().toArray()
        if (!collections.map((c) => c.name).includes(collection)) {
          await database.createCollection(collection)
        }
        this._collection_exists = true
      }

      const col = database.collection(collection)
      col.createIndex({ key: 1 }, { unique: true, background: true })
      col.createIndex({ tags: 1 }, { background: true })
      col.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, background: true })

      return col
    }
  }

  async get (keys = [], session) {
    const now = Date.now()
    const col = await this.collection()

    const docs = await col
      .find({ key: { $in: keys } }, { projection: { key: 1, expires_at: 1, value: 1 }, session })
      .toArray()

    const mapped = docs.reduce((map, doc) => {
      if (doc.expires_at && doc.expires_at < now) return map
      if (doc.value && doc.value._bsontype === 'Binary') {
        map[doc.key] = doc.value.buffer
      } else {
        map[doc.key] = doc.value
      }
      return map
    }, {})

    return keys.map((k) => mapped[k])
  }

  async set (keyvalues = []) {
    const now = Date.now()
    const col = await this.collection()

    let previous
    await this.client.withSession(async (session) => {
      await session.withTransaction(async (session) => {
        previous = await this.get(keyvalues.map((kv) => kv.key), session)

        const operations = keyvalues.map((kv) => {
          const { key, value, ttl, tags = [] } = kv
          const op = {
            replaceOne: {
              filter: { key },
              replacement: { key, value, tags },
              upsert: true
            }
          }

          if (ttl) {
            op.replaceOne.replacement.expires_at = new Date(now + ttl)
          }

          return op
        })

        await col.bulkWrite(operations, { session, ordered: false })
      })
    })

    return previous
  }

  async del (keys = []) {
    const col = await this.collection()

    let previous
    await this.client.withSession(async (session) => {
      await session.withTransaction(async (session) => {
        previous = await this.get(keys, session)
        await col.deleteMany({ key: { $in: keys } }, { session })
      })
    })

    return previous
  }

  async tags (keys = []) {
    const now = Date.now()
    const col = await this.collection()

    const docs = await col.find({ key: { $in: keys } }, { key: 1, expires_at: 1, tags: 1 }).toArray()
    const mapped = docs.reduce((map, doc) => {
      if (doc.expires_at && doc.expires_at < now) return map
      map[doc.key] = doc.tags
      return map
    }, {})

    return keys.map((key) => mapped[key] || [])
  }

  async dropKeys (globs = []) {
    const col = await this.collection()

    let response
    await this.client.withSession(async (session) => {
      await session.withTransaction(async (session) => {
        response = await Promise.all(globs.map((glob) => {
          return col.deleteMany({ key: { $regex: globber(glob) } }, { session })
        }))
      })
    })

    return response.map(({ result }) => result.n)
  }

  async dropTags (tags = []) {
    const col = await this.collection()

    let response
    await this.client.withSession(async (session) => {
      await session.withTransaction(async (session) => {
        response = await Promise.all(tags.map((tag) => {
          return col.deleteMany({ tags: tag })
        }))
      })
    })

    return response.map(({ result }) => result.n)
  }

  tagged (tag) {
    return this._keyStream({ tags: tag })
  }

  keys (glob) {
    return this._keyStream({ key: { $regex: globber(glob) } })
  }

  async close () {
    return this.client.close()
  }

  _keyStream (query) {
    const now = Date.now()
    const stream = new PassThrough({
      writableObjectMode: true,
      readableObjectMode: true
    })

    this.collection().then((col) => {
      col.find(query, { key: 1, expires_at: 1 })
        .stream()
        .pipe(stream)
    })

    return stream.pipe(transform((doc) => {
      if (doc.expires_at && doc.expires_at < now) return null
      return doc.key
    }))
  }
}
