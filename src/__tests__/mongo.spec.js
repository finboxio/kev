const env = require('envvar')
const tests = require('./core.spec.js')

const MONGO_URL = env.string('MONGO_URL', '')

tests(MONGO_URL)
