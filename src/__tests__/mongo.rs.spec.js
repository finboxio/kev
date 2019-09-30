const env = require('envvar')
const tests = require('./core.spec.js')

const MONGO_RS_URL = env.string('MONGO_RS_URL', '')

tests(MONGO_RS_URL)
