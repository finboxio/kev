const uid = require('uid')

const Kev = require('..')

const tests = require('./core.spec.js')

tests('memory://')

describe('max memory', () => {
  const kev = new Kev({
    url: 'memory://lru',
    prefix: `test-${uid()}`,
    memory: { max_memory: '36B' }
  })

  beforeEach(() => kev.dropKeys())
  afterAll(() => kev.close())

  it('should expire old keys if the size exceeds max memory', async () => {
    await kev.set('1', '123')
    await kev.set('2', '234')
    let keys = await kev.keys().toArray()
    expect(keys.sort()).toEqual([ '1', '2' ])

    await kev.set('3', '345')
    keys = await kev.keys().toArray()
    expect(keys.sort()).toEqual([ '2', '3' ])
  })

  it('should expire keys on an LRU basis', async () => {
    await kev.set('1', '123')
    await kev.set('2', '234')
    let keys = await kev.keys().toArray()
    expect(keys.sort()).toEqual([ '1', '2' ])

    await kev.get('1')
    await kev.set('3', '345')
    keys = await kev.keys().toArray()
    expect(keys.sort()).toEqual([ '1', '3' ])
  })
})
