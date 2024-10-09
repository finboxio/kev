const Aerospike = require('aerospike');
const globber = require('glob-to-regexp')
const transform = require('stream-transform')

const TOTAL_TIMEOUT = 2000;
const NODE_MAJOR_VERSION = Number(process.versions.node.split('.')[0]);


module.exports = class KevAerospike {
  constructor (url, options = {}) {
    const { namespace, set } = options;

    this.client = Aerospike.client({
      hosts: url,
      policies: {
        read: new Aerospike.ReadPolicy({
          totalTimeout: TOTAL_TIMEOUT
        }),
        write: new Aerospike.WritePolicy({
          totalTimeout: TOTAL_TIMEOUT,
          key: Aerospike.policy.key.SEND
        }),
        batch: new Aerospike.BatchPolicy({
          key: Aerospike.policy.key.SEND,
          totalTimeout: TOTAL_TIMEOUT
      }),
      },
    });

    this._namespace = namespace || 'test';
    this._set = set || 'demo';

    const tagsIndexOptions = {
      ns: this._namespace,
      set: this._set,
      bin: 'tags',
      index: 'tags_idx',
      type: Aerospike.indexType.LIST,
      datatype: Aerospike.indexDataType.STRING,
    }
    
    this._connected = this.client.connect().then(() => this.client.createIndex(tagsIndexOptions))
  }

  async get (keys = []) {
    await this._connected;
    const aKeys = keys.map(k => new Aerospike.Key(this._namespace, this._set, k))
    const result = await this.client.batchGet(aKeys)
    return result.map((value) => {
      if (!value.record?.bins
        || value.record.bins.data?.e != value.record.bins.data?.s
          && value.record.bins.data.e < Date.now()
      ) {
        return undefined
      }
      return value?.record?.bins?.data
    })
  }

  async set (keyvalues = []) {
    await this._connected;
    
    const batchRecords = keyvalues.map(({ key, value, ttl, tags }) => ({
        type: Aerospike.batchType.BATCH_WRITE,
        key: new Aerospike.Key(this._namespace, this._set, key),
        ops: [
            Aerospike.operations.write('data', value),
            Aerospike.operations.write('tags', tags),
        ],
        policy: new Aerospike.BatchWritePolicy({
          exists: Aerospike.policy.exists.IGNORE,
          key: Aerospike.policy.key.SEND,
          ttl: (ttl > 0 ? ttl / 1000 : undefined),
        })
    }))

    const previous = await this.get(keyvalues.map(({ key }) => key))

    if (NODE_MAJOR_VERSION > 14) {
      await this.client.batchWrite(batchRecords)
    } else {
      await Promise.all(keyvalues.map(async ({ key, value, ttl, tags }) => {
        const aKey = new Aerospike.Key(this._namespace, this._set, key)
        await this.client.put(aKey, { data: value, tags }, { ttl });
      }))
    }
    return previous
  }

  async del (keys = []) {
    await this._connected;
    const aKeys = keys.map(k => new Aerospike.Key(this._namespace, this._set, k))
    const previous = await this.client.batchGet(aKeys)
    const removed = await this.client.batchRemove(aKeys)
    return removed.map(r => previous.find(p => p.record?.key?.key === r.record?.key?.key).record?.bins?.data)
  }

  async tags (keys = []) {
    await this._connected;
    const aKeys = keys.map(k => new Aerospike.Key(this._namespace, this._set, k))
    const result = await this.client.batchGet(aKeys);
    return result.map(r => r.record.bins.tags)
  }

  async dropKeys (globs = []) {
    await this._connected;

    const keysToDelete = await Promise.all(globs.map(async (glob, i) => {
      let regexStr = String(globber(glob))

      const regexmatch = Aerospike.exp.cmpRegex(0, regexStr.slice(1, regexStr.length - 1), Aerospike.exp.keyStr('data'))
      const query = this.client.query(this._namespace, this._set)
      const recordsToDelete = await query.results({ filterExpression: regexmatch });
      return recordsToDelete.map(r => r.key);
    }))
    const result = await Promise.all(keysToDelete.map(ktd => this.client.batchRemove(ktd)))
    const results = new Array(result.length).fill(0);

    result.map((r, i) => {
      results[i] = r.length;
    })
    return results
  }

  async dropTags (tags = []) {
    await this._connected;
    const keysToDelete = await Promise.all(tags.map(async tag => {
      const query = this.client.query(this._namespace, this._set)
      query.where(Aerospike.filter.contains('tags', tag, Aerospike.indexType.LIST));
      const recordsToDelete = await query.results();
      return recordsToDelete.map(r => r.key).filter(Boolean);
    }))
    const results = await Promise.all(keysToDelete.map(ktd => this.client.batchRemove(ktd)));
    return results.map(r => r.length)
  }

  tagged (tag) {
    const query = this.client.query(this._namespace, this._set)
    query.where(Aerospike.filter.contains('tags', tag, Aerospike.indexType.LIST));
    const results = query.foreach();
    const outStr = results.pipe(transform((record) => !record.bins || record.bins.data?.e != record.bins.data?.s && record.bins?.data?.e < Date.now() ? undefined : record.key.key))
    return outStr
  }

  keys (glob) {
    let regexStr = String(globber(glob))
    const regexmatch = Aerospike.exp.cmpRegex(0, regexStr.slice(1, regexStr.length - 1), Aerospike.exp.keyStr('data'))
    const query = this.client.query(this._namespace, this._set)
    const results = query.foreach({ filterExpression: regexmatch });
    const outStr = results.pipe(transform((record) => record.key.key))

    return outStr;
  }

  async close () {
    await this._connected;
    return client.close()
  }
}
