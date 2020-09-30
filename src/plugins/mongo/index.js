const { PassThrough } = require('stream')

const { MongoClient } = require('mongodb')
const globber = require('glob-to-regexp')
const transform = require('stream-transform')

module.exports = class KevMongo {
  constructor (url, { client, db, collection = 'kev', use_transactions = true ...options } = {}) {
    this._collection_verified = false
    this.client = client || new MongoClient(url, { ...options, useNewUrlParser: true, useUnifiedTopology: true })

    this._connect = Promise.resolve(this.client).then((client) => !client.isConnected() ? client.connect() : client)

    this.transactions = use_transactions
    this.collection = async () => {
      const client = await this.client

      if (!client.isConnected()) {
        await this._connect
      }

      const database = client.db(db)
      if (!this._collection_verified) {
        this._collection_verified = true
        const collections = await database.listCollections().toArray()
        if (!collections.map((c) => c.name).includes(collection)) {
          await database.createCollection(collection)
            .catch((e) => process.emitWarning(e.message, 'KevCollectionWarning'))
        }
        const col = database.collection(collection)
        col.createIndex({ key: 1 }, { unique: true, background: true })
          .catch((e) => process.emitWarning(e.message, 'KevIndexWarning'))
        col.createIndex({ tags: 1 }, { background: true })
          .catch((e) => process.emitWarning(e.message, 'KevIndexWarning'))
        col.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, background: true })
          .catch((e) => process.emitWarning(e.message, 'KevIndexWarning'))
      }

      return database.collection(collection)
    }
    this.collection()
  }

  async get (keys = [], session) {
    const now = Date.now()
    const col = await this.collection()

    const docs = await col
      .find({ key: { $in: keys } }, { projection: { key: 1, expires_at: 1, value: 1 }, session })
      .toArray()

    const mapped = docs.reduce((map, doc) => {
      if (doc.expires_at && doc.expires_at < now) return map
      if (doc.value && doc.value.v && doc.value.v._bsontype === 'Binary') {
        map[doc.key] = { ...doc.value, v: doc.value.v.buffer }
      } else {
        map[doc.key] = doc.value
      }
      return map
    }, {})

    return keys.map((k) => mapped[k])
  }

  async set (keyvalues = []) {
    const now = Date.now()
    const [ client, col ] = await Promise.all([ this.client, this.collection() ])

    let previous
    const execute = async (session) => {
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
    }

    if (this.transactions && client.topology.hasSessionSupport()) {
      await client
        .withSession((session) => session.withTransaction(execute))
        .catch((err) => {
          err = err.originalError || err
          if (err.code === 20 && err.message.startsWith('Transaction numbers')) {
            emitTransactionWarning(client.s.url)
            return execute()
          } else {
            throw err
          }
        })
    } else {
      emitTransactionWarning(client.s.url)
      await execute()
    }

    return previous
  }

  async del (keys = []) {
    const [ client, col ] = await Promise.all([ this.client, this.collection() ])

    let previous
    const execute = async (session) => {
      previous = await this.get(keys, session)
      await col.deleteMany({ key: { $in: keys } }, { session })
    }

    if (this.transactions && client.topology.hasSessionSupport()) {
      await client
        .withSession((session) => session.withTransaction(execute))
        .catch((err) => {
          err = err.originalError || err
          if (err.code === 20 && err.message.startsWith('Transaction numbers')) {
            emitTransactionWarning(client.s.url)
            return execute()
          } else {
            throw err
          }
        })
    } else {
      emitTransactionWarning(client.s.url)
      await execute()
    }

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
    const [ client, col ] = await Promise.all([ this.client, this.collection() ])

    let response
    const execute = async (session) => {
      response = await Promise.all(globs.map((glob) => {
        return col.deleteMany({ key: { $regex: globber(glob) } }, { session })
      }))
    }

    if (this.transactions && client.topology.hasSessionSupport()) {
      await client
        .withSession((session) => session.withTransaction(execute))
        .catch((err) => {
          err = err.originalError || err
          if (err.code === 20 && err.message.startsWith('Transaction numbers')) {
            emitTransactionWarning(client.s.url)
            return execute()
          } else {
            throw err
          }
        })
    } else {
      emitTransactionWarning(client.s.url)
      await execute()
    }

    return response.map(({ result }) => result.n)
  }

  async dropTags (tags = []) {
    const [ client, col ] = await Promise.all([ this.client, this.collection() ])

    let response
    const execute = async (session) => {
      response = await Promise.all(tags.map((tag) => {
        return col.deleteMany({ tags: tag })
      }))
    }

    if (this.transactions && client.topology.hasSessionSupport()) {
      await client
        .withSession((session) => session.withTransaction(execute))
        .catch((err) => {
          err = err.originalError || err
          if (err.code === 20 && err.message.startsWith('Transaction numbers')) {
            emitTransactionWarning(client.s.url)
            return execute()
          } else {
            throw err
          }
        })
    } else {
      emitTransactionWarning(client.s.url)
      await execute()
    }

    return response.map(({ result }) => result.n)
  }

  tagged (tag) {
    return this._keyStream({ tags: tag })
  }

  keys (glob) {
    return this._keyStream({ key: { $regex: globber(glob) } })
  }

  async close () {
    return Promise.resolve(this.client).then((c) => c.close())
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

const warned = {}
const emitTransactionWarning = function (url) {
  if (!warned[url]) {
    warned[url] = true
    process.emitWarning(`Kev mongo server at ${url} does not support transactions`)
  }
}
