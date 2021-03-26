const Kev1 = require('kev1')
const Kev2 = require('kev2')

const url1 = ''
const col1 = ''

const url2 = ''
const col2 = ''

const run = async () => {
  const kFrom = new Kev1({ url: url1, mongo: { collection: col1 } })
  const kTo = new Kev2({ url: url2, mongo: { collection: col2 } })

  const keystream = kFrom.keys()
  keystream.on('data', async (key) => {
    const value = await kFrom.get(key)
    await kTo.set(key, value)
  })

  return new Promise((resolve, reject) => {
    keystream.on('error', reject)
    keystream.on('end', resolve)
  })
}

run()
  .then(() => console.log('done'))
  .catch((e) => console.error(e))
