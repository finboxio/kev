const delay = require('delay')
const uid = require('uid')
const zlib = require('zlib')
const { promisify } = require('util')

const Kev = require('..')

module.exports = (url) => {
  const compressions = [ false, { type: 'gzip' }, { type: 'deflate', encoding: 'hex' }, { type: 'brotli', encoding: 'base64' } ]
  const serializers = [ undefined, 'v8', 'json', 'raw', 'resurrect' ]
  for (const compression of compressions) {
    for (const serializer of serializers) {
      runTests({ url, compression, serializer }, { skip: !url })
    }
  }
}

const runTests = ({ url, serializer, compression = false }, { skip = false } = {}) => {
  const it = skip ? test.skip : test

  const test_type_restoration = true &&
    /* json.stringified data does not maintain type info */
    ![ 'json' ].includes(serializer) &&
    /* redis will not persist types unless serializer supports it or compression is enabled */
    !(url.match(/redis:|mongo:/) && (!compression || [ 'v8', 'resurrect' ].includes(serializer)))

  const test_undef_restoration = true &&
    /* json.stringified data does not maintain undefined info */
    ![ 'json' ].includes(serializer) &&
    /* redis/mongo will not persist types unless serializer supports it or compression is enabled */
    !(url.match(/redis:|mongo:/) && (!compression || [ 'v8', 'resurrect' ].includes(serializer)))

  describe(`${url} (compression=${compression && compression.type}, serializer=${serializer})`, () => {
    const prefix = `test-${uid()}`
    const kev = new Kev({ url, prefix, compression, serializer, tags: [ 't1' ] })

    beforeEach(() => kev.dropKeys())
    afterAll(() => kev.close())

    describe('set/get', () => {
      it('should store key-value pairs', async () => {
        const set = await kev.set('key', 10)
        expect(set).toStrictEqual(undefined)

        const get = await kev.get('key')
        expect(get).toStrictEqual(10)
      })

      it('should store multiple key-value pairs', async () => {
        const g = await kev.get([ 'key', 'key2' ])
        expect(g).toStrictEqual({ key: undefined, key2: undefined })

        const set = await kev.set({ key: 10, key2: 20 })
        expect(set).toStrictEqual({ key: undefined, key2: undefined })

        const get = await kev.get([ 'key', 'key2' ])
        expect(get).toStrictEqual({ key: 10, key2: 20 })
      })

      it('should update values', async () => {
        await kev.set('key', 10)

        const set = await kev.set('key', 20)
        expect(set).toStrictEqual(10)

        const get = await kev.get('key')
        expect(get).toStrictEqual(20)
      })

      it('should store numeric values', async () => {
        await kev.set('key', 1)
        const get = await kev.get('key')
        expect(get).toStrictEqual(1)
      })

      it('should store string values', async () => {
        await kev.set('key', 'string')
        const get = await kev.get('key')
        expect(get).toStrictEqual('string')
      })

      it('should store boolean values', async () => {
        await kev.set('key', true)
        const get = await kev.get('key')
        expect(get).toStrictEqual(true)
      })

      if (test_type_restoration) {
        it('should store date values', async () => {
          await kev.set('key', new Date(1))
          const get = await kev.get('key')
          expect(get.constructor.name).toBe('Date')
          expect(get).toEqual(new Date(1))
        })

        it('should store regexp values', async () => {
          await kev.set('key', /xyz/)
          const get = await kev.get('key')
          expect(get.constructor.name).toBe('RegExp')
          expect(get).toEqual(/xyz/)
        })

        it('should store circular references', async () => {
          const circular = { a: 1 }
          circular.circular = circular
          await kev.set('circular', circular)
          const get = await kev.get('circular')
          expect(get.circular.circular.a).toStrictEqual(1)
        })
      }

      it('should store non-truthy values', async () => {
        const values = { num: 0, str: '', bool: false, nil: null }
        if (test_undef_restoration) {
          values.undef = undefined
        }

        await kev.set(values)
        const get = await kev.get(Object.keys(values))
        expect(get).toStrictEqual(values)
      })

      it('should store array values', async () => {
        const array = [ 1, '2', !4 ]
        if (test_undef_restoration) array.push(undefined)
        if (test_type_restoration) array.push(new Date(1))
        if (test_type_restoration) array.push(/xyz/)

        await kev.set('key', array)
        const get = await kev.get('key')
        expect(get).toEqual(array)
      })

      it('should store object values', async () => {
        const object = { num: 1, str: '2', bool: !4, arr: [ 1 ], obj: { a: 1 } }
        if (test_undef_restoration) object.undef = undefined
        if (test_type_restoration) object.date = new Date(1)
        if (test_type_restoration) object.regexp = /xyz/

        await kev.set('key', object)
        const get = await kev.get('key')
        expect(get).toEqual(object)
      })
    })

    describe('del', () => {
      it('should delete keys', async () => {
        await kev.set('key', 10)
        await expect(kev.del('key')).resolves.toStrictEqual(10)
        await expect(kev.get('key')).resolves.toBeUndefined()
      })

      it('should delete many keys', async () => {
        await kev.set({ key: 10, key2: 20 })
        await expect(kev.del([ 'key', 'key2' ])).resolves.toStrictEqual({ key: 10, key2: 20 })
        await expect(kev.get([ 'key', 'key2' ])).resolves.toStrictEqual({ key: undefined, key2: undefined })
      })
    })

    describe('dropKeys', () => {
      it('should drop all keys matching the pattern', async () => {
        await kev.set({ key: 10, key2: 20, other: 30 })
        await expect(kev.dropKeys('key*')).resolves.toStrictEqual(2)
        await expect(kev.get([ 'key', 'key2', 'other' ])).resolves.toStrictEqual({
          key: undefined,
          key2: undefined,
          other: 30
        })
      })

      it('should drop keys matching multiple patterns', async () => {
        await kev.set({ key: 10, key2: 20, ley: 1, other: 30 })
        await expect(kev.dropKeys([ '*ey', '*2' ])).resolves.toStrictEqual({ '*ey': 2, '*2': 1 })
        await expect(kev.get([ 'key', 'key2', 'ley', 'other' ])).resolves.toStrictEqual({
          key: undefined,
          key2: undefined,
          ley: undefined,
          other: 30
        })
      })
    })

    describe('dropTag', () => {
      it('should drop all keys with that tag', async () => {
        await kev.set({ key: 10, key2: 20 }, { tags: [ 'tag' ] })
        await kev.set({ ley: 30, ley2: 40 }, { tags: [ 'tag2' ] })
        await expect(kev.dropTag('tag')).resolves.toStrictEqual(2)
        await expect(kev.get([ 'key', 'key2', 'ley', 'ley2' ])).resolves.toStrictEqual({
          key: undefined,
          key2: undefined,
          ley: 30,
          ley2: 40
        })
      })

      it('should drop all keys with multiple tags', async () => {
        await kev.set({ key: 10, key2: 20 }, { tags: [ 'tag' ] })
        await kev.set({ ley: 30, ley2: 40 }, { tags: [ 'tag2' ] })
        await kev.set({ mey: 50, mey2: 60 }, { tags: [ 'tag3' ] })
        await expect(kev.dropTag([ 'tag', 'tag3' ])).resolves.toStrictEqual({ tag: 2, tag3: 2 })
        await expect(kev.get([ 'key', 'key2', 'ley', 'ley2', 'mey', 'mey2' ])).resolves.toStrictEqual({
          key: undefined,
          key2: undefined,
          ley: 30,
          ley2: 40,
          mey: undefined,
          mey2: undefined
        })
      })
    })

    describe('prefix', () => {
      const kev2 = kev.withPrefix('child')
      const kev3 = kev2.withPrefix('grandchild')

      it('should only set keys in the given prefix', async () => {
        await kev.set('key', 1)
        await expect(kev2.get('key')).resolves.toBeUndefined()
      })

      it('should not delete keys across prefixes', async () => {
        await kev.set('key', 1)
        await kev2.set('key', 2)
        await kev.del('key')
        await expect(kev2.get('key')).resolves.toStrictEqual(2)
      })

      it('should not drop keys across prefixes', async () => {
        await kev.set('key', 1)
        await kev2.set('key', 2)
        await kev.dropKeys('key*')
        await expect(kev2.get('key')).resolves.toStrictEqual(2)
      })

      it('should associate default parent tags', async () => {
        await kev.set('parent', 1)
        await kev2.set('child', 2)
        await expect(kev2.tagged('t1').toArray()).resolves.toStrictEqual([ 'child' ])
        return expect(kev.tagged('t1').toArray().then((a) => a.sort())).resolves.toStrictEqual([ 'parent', 'child:child' ].sort())
      })

      it('should apply parent tags to children', async () => {
        await kev.set('key', 1)
        await kev2.set('key', 2)
        await kev3.set('key', 3)

        const p1 = await kev.tagged('t1').toArray()
        const c1 = await kev2.tagged('t1').toArray()
        const g1 = await kev3.tagged('t1').toArray()

        expect(p1.sort()).toStrictEqual([ 'key', 'child:key', 'child:grandchild:key' ].sort())
        expect(c1.sort()).toStrictEqual([ 'key', 'grandchild:key' ].sort())
        expect(g1.sort()).toStrictEqual([ 'key' ].sort())

        await kev2.dropTag('t1')
        await expect(kev.get('key')).resolves.toStrictEqual(1)
        await expect(kev2.get('key')).resolves.toBeUndefined()
        await expect(kev3.get('key')).resolves.toBeUndefined()
      })

      it('should return child keys from the parent', async () => {
        await kev2.set('key', 1)
        await expect(kev.keys().toArray()).resolves.toStrictEqual([ 'child:key' ])
      })
    })

    describe('ttl', () => {
      const kev = new Kev({ url, prefix, compression, serializer, ttl: '1000ms' })
      afterAll(() => kev.dropKeys().then(() => kev.close()))

      it('should expire keys after the default ttl period', async () => {
        await kev.set('key', 1)
        await expect(kev.get('key')).resolves.toStrictEqual(1)
        await delay(500)
        await expect(kev.get('key')).resolves.toStrictEqual(1)
        await delay(1000)
        await expect(kev.get('key')).resolves.toBeUndefined()
      })

      it('should expire keys after a custom ttl period', async () => {
        await kev.set('key', 1, { ttl: '1000ms' })
        await expect(kev.get('key')).resolves.toStrictEqual(1)
        await delay(1500)
        await expect(kev.get('key')).resolves.toBeUndefined()
      })

      it('should provide child instances with a custom ttl', async () => {
        const k2 = kev.withTTL('1000ms')
        await k2.set('key', 1)
        await expect(k2.get('key')).resolves.toStrictEqual(1)
        await delay(1500)
        await expect(k2.get('key')).resolves.toBeUndefined()
      })
    })

    describe('tags', () => {
      const kev = new Kev({ url, prefix, compression, serializer, tags: [ 'tag' ] })
      afterAll(() => kev.dropKeys().then(() => kev.close()))

      it('should add default tags to all entries', async () => {
        await kev.set('key', 1)
        const tags = await kev.tags('key')
        expect(tags).toStrictEqual([ 'tag' ])
      })

      it('should provide child instances with additional tags', async () => {
        await kev.set('key', 1)
        const k2 = kev.withTags([ 'tag2' ])
        await k2.set('key2', 2)
        const keys1 = await k2.tagged('tag').toArray()
        expect(keys1.sort()).toStrictEqual([ 'key', 'key2' ].sort())
        const keys2 = await k2.tagged('tag2').toArray()
        expect(keys2.sort()).toStrictEqual([ 'key2' ])
      })

      it('should return an empty list if no matching tag is found', async () => {
        const keys = await kev.tagged('untagged').toArray()
        expect(keys).toStrictEqual([])
      })

      it('should not include deleted keys', async () => {
        await kev.set('key', 1)
        await kev.del('key')
        await expect(kev.tagged('tag').toArray()).resolves.toStrictEqual([])
      })

      it('should not include expired keys', async () => {
        await kev.set('key', 1, { ttl: 100 })
        await delay(1000)
        await expect(kev.tagged('tag').toArray()).resolves.toStrictEqual([])
      })

      it('should not include updated keys', async () => {
        await kev.set('key', 1, { tags: [ 'tag2' ] })
        await expect(kev.tagged('tag2').toArray()).resolves.toStrictEqual([ 'key' ])
        await kev.set('key', 2)
        await expect(kev.tagged('tag2').toArray()).resolves.toStrictEqual([])
      })
    })

    describe('keys', () => {
      it('should stream all stored keys', async () => {
        await kev.set('key', 1)
        const keys = await kev.keys().toArray()
        expect(keys).toStrictEqual([ 'key' ])
      })

      it('should not include deleted keys', async () => {
        await kev.set('key', 1)
        await kev.del('key')
        const keys = await kev.keys().toArray()
        expect(keys).toStrictEqual([])
      })

      it('should include only matching keys', async () => {
        await kev.set({ key: 1, key2: 2 })
        const keys = await kev.keys('*2').toArray()
        expect(keys).toStrictEqual([ 'key2' ])
      })
    })

    describe('compression', () => {
      if (compression) {
        it('should support retrieving raw (compressed) data if compression is on', async () => {
          const fn = {
            gzip: 'gzip',
            deflate: 'deflate',
            brotli: 'brotliCompress'
          }[compression.type]
          const packed = await kev.serializer.pack('string')
          let compressed = await promisify(zlib[fn])(packed)
          if (compression.encoding) {
            compressed = compressed.toString(compression.encoding)
          }

          await kev.set('key', 'string')
          const data = await kev.get('key', { decompress: false })
          expect(data).toEqual(compressed)
        })
      } else {
        it('should not be affected by the decompress option if compression is not on', async () => {
          await kev.set('key', 'string')
          const data = await kev.get('key', { decompress: false })
          expect(data).toEqual('string')
        })
      }
    })
  })
}
