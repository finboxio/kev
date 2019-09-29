
1.2.0 / 2019-09-28
==================

  * Update mongo driver and allow user to provide mongo client

1.1.0 / 2019-08-18
==================

  * Add v8 serialization for improved performance

1.0.1 / 2019-06-13
==================

  * Queue close until next tick

1.0.0 / 2019-06-06
==================
  * Transition to docker/jest dev environment
  * Rewrite API for async
  * Support atomic transactions in mongo/redis
  * Dataloaders for batching get/set/del requests
  * Support for child buckets using kev.withPrefix('child')

0.6.8 / 2017-02-21
==================

  * fix bug re: keys with spaces in memory plugin
  * move redis/mongo out of peerDependencies into devDependencies

0.6.7 / 2016-05-28
==================

  * fix get bug when redis connection is pending

0.6.6 / 2016-05-27
==================

  * add bulk get/set/del test
  * fix redis bulk insert & double-prefixing
  * fix mongo bulk insert

0.6.5 / 2016-03-22
==================

  * fix memory ttl

0.6.4 / 2016-03-16
==================

  * fix put when options and fn are undefined

0.6.3 / 2016-03-13
==================

  * fix ttl override parsing

0.6.2 / 2016-03-13
==================

  * fix bug overwriting default plugin options

0.6.1 / 2016-03-13
==================

  * fix redis bug overwriting this.options with individual call options
  * fix mongo bug overwriting this.options with individual call options

0.6.0 / 2016-03-11
==================

  * consolidate memory, mongo, and redis plugins into main lib for now to simplify development cycle

0.5.0 / 2016-03-10
==================

  * add get options, flush kev on test end

0.4.0 / 2016-03-10
==================

  * add tag & dropTag to api

0.3.0 / 2016-03-10
==================

  * add put options to api, standardize arguments passed to plugin functions, factor out plugin test code, support multi-put/del
  * add batch puts/dels to TODO

0.2.1 / 2015-09-21
==================

  * update repository field in package.json, pin deps, add make install

0.2.0 / 2015-09-21
==================

  * switch tests to promises, add batch get to kev-memory

0.1.0 / 2015-07-13
==================
  * Pulled out mongo and redis adapters into separate repos
  * Cleaned up dependency structure

0.0.2 / 2015-03-01
==================

  * Fixed callback params in Mongo 'put' adapter (result was being passed in error param)
  * Remove unused MongoServer from test

0.0.1 / 2015-02-28
==================
 * Initial Commit
 * Kev API & adapters for Mongo, Redis, and Memory
 * Tests
