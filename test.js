'use strict';

let Zenith = require('./index.js');

let config = require('./test-config.js');

class ZenithTests
{
	serverInfo(zenith) {
		return zenith.zenith_serverInfo().then(serverInfo => {
			console.log('Connected to ' + serverInfo.Name + ' running v'
				+ serverInfo.Version);
			if (serverInfo.Name == undefined) {
				throw Error('Unable to obtain server name');
			}
		});
	}

	queryIdentify(zenith) {
		return zenith.auth_queryIdentify().then(identity => {
			if (identity.UserID != config.username) {
				throw Error('Unexpected user ID.  Expected "' + config.username
					+ '", got "' + identity.UserID + '"');
			}
		});
	}
};

function runTests(zenith)
{
	let tests = new ZenithTests();
	let flow = Promise.resolve();
	let testNumber = 0;
	let numSuccess = 0;
	let numFail = 0;
	Object.getOwnPropertyNames(ZenithTests.prototype).forEach(testName => {
		if (testName == 'constructor') return;
		flow = flow
			.then(() => {
				++testNumber;
				console.log('[' + testNumber + ':' + testName + '] Begin');
				return tests[testName](zenith);
			})
			.then(() => {
				console.log('[' + testNumber + ':' + testName + '] Complete');
				++numSuccess;
			})
			.catch(err => {
				console.log('[' + testNumber + ':' + testName + '] Test failed:', err);
				++numFail;
			});
	});
	return flow.then(() => {
		return {
			count: testNumber,
			success: numSuccess,
			fail: numFail,
		};
	});
}

let zenith = new Zenith.WebSockets(config);
zenith.debug = true;
zenith.connect()
	.then(() => {
		console.log('Connected');
		runTests(zenith).then(stats => {
			zenith.disconnect();
			console.log('Tests complete: '
				+ stats.count + ' tests run, '
				+ stats.success + ' successful, '
				+ stats.fail + ' failed.');
		});
	})
	.catch(err => {
		console.log('Unable to connect:', err.message);
		zenith.disconnect();
	});
