const env = require('envvar')
const tests = require('./core.spec.js')

const AEROSPIKE_URL = env.string('AEROSPIKE_URL', '')
tests(AEROSPIKE_URL)