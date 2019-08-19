const env = require('envvar')
const tests = require('./core.spec.js')

const REDIS_URL = env.string('REDIS_URL', '')

tests(REDIS_URL)
