'use strict';

let OAuth2 = require('client-oauth2');
let WebSocket = require('ws');
let ZenithError = require('./error.js');

const PING_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 10000;
const SUB_PING_TIMEOUT_MS = 10000;

class ZenithWS
{
	/**
	 * @param object credentials
	 *   Login details.  Has members:
	 *    - string clientId: Client ID to connect with.
	 *    - string clientSecret: Corresponding secret key for client ID.
	 *    - string username: Account username this client ID can connect as.
	 *    - string password: Account password for username.
	 */
	constructor(credentials, useProduction, apiVersion = undefined) {
		this.credentials = credentials;
		this.useProduction = useProduction;
		this.apiVersion = apiVersion;

		this.debug = false;
		this.reconnect = true;
		this.connected = false;
		this.lastTransactionID = 0;
		this.pending = {}; // API calls waiting for a server response
		this.subscriptions = []; // Things we want unsolicited notifications about
		this.fnDisconnect = null; // callback on disconnection
	}

	/// Authenticate with OAuth and set this.token.
	/*private*/ auth() {
		let authData = {
			clientId: this.credentials.clientId,
			clientSecret: this.credentials.clientSecret,
			scopes: [
				'http://api.paritech.com/wsapi'
			],
		};
		if (this.useProduction) {
			authData.authorizationUri = 'https://api.paritech.com/Paritech.AuthServer/OAuth2/Authorise';
			authData.accessTokenUri = 'https://api.paritech.com/Paritech.AuthServer/OAuth2/Token';
		} else {
			authData.authorizationUri = 'https://apistaging.paritech.com/Paritech.AuthServer/OAuth2/Authorise';
			authData.accessTokenUri = 'https://apistaging.paritech.com/Paritech.AuthServer/OAuth2/Token';
		}
		this.oauth = new OAuth2(authData);
		return this.oauth.owner.getToken(this.credentials.username, this.credentials.password)
			.then(token => {
				this.token = token;

				// Set up the token refresh timer
				this.auth_setRefresh();
			})
			.catch(err => {
				if (err.code) { // PopsicleError
					throw new ZenithError(err.code, 'Connection error: ' + err.code);
				} else {
					let data = JSON.parse(err.body);
					switch (data.error) {
						case 'invalid_client':
							throw new ZenithError('BADCREDS', 'Bad credentials: ' + data.error_description);
						case 'unauthorized_client':
							throw new ZenithError('NOACCESS', 'Unauthorized client (credentials ok, no access)');
						default:
							throw new ZenithError(data.error, data.error_description);
							break;
					}
				}
			});
	}

	/// Get the list of OAuth scopes returned.
	auth_getScopes() {
		return this.token.data.scope;
	}

	/// Set up a timer to refresh the token before it expires.
	/*private*/ auth_setRefresh() {
		if (this.debug) console.log('[zenith] Token expires in ' + this.token.data.expires_in
			+ ' seconds, setting timer');
		if (this.tokenTimer) clearTimeout(this.tokenTimer);
		this.tokenTimer = setTimeout(() => {
			this.auth_refreshToken();
		}, this.token.data.expires_in * 900); // 900 = 10% less seconds -> milliseconds
	}

	/// Refresh the token and reset the timer.
	/*private*/ auth_refreshToken() {
		return this.token.refresh().then(token => {
			this.token = token;
			this.auth_setRefresh();
			// Call the API to notify it of our new token
			return this.auth_authToken();
		});
	}

	/// Authenticate and set up the WebSocket connection.
	connect(fnDisconnect) {
		this.fnDisconnect = fnDisconnect;
		return this.auth()
			.then(this.connect_ws.bind(this))
		;
	}

	/// Connect to the WebSocket using this.token as credentials.
	/*private*/ connect_ws() {
		return new Promise((fulfill, reject) => {
			let url = '';
			if (this.useProduction) {
				url = 'wss://wsapi.paritech.com/Zenith';
			} else {
				url = 'wss://wsapistaging.paritech.com/Zenith';
			}
			if (this.apiVersion) {
				url += '?version=' + this.apiVersion;
			}
			try {
				let wsOptions = {};
				this.token.sign(wsOptions);
				this.ws = new WebSocket(url, 'ZenithJson', wsOptions);
			} catch (e) {
				console.log(e);
				return;
			}

			this.ws.on('open', () => {
				// Connected successfully
				this.connected = true;
				this.resetPingTimeout();
				fulfill();
			});

			this.ws.on('error', e => {
				console.log('WebSocket error:', e);
				if (!this.connected) {
					// Haven't connected yet
					this.reconnect = false; // don't try again
					reject(e);
				}
				// else we are already connected, ignore and let the 'close'
				// handler try to reconnect
			});

			this.ws.on('close', () => {
				// Note this happens on a connection error (like connection refused) as
				// well as on intentional disconnection.
				if (!this.reconnect) return; // intentional disconnection
				if (this.debug) console.log('[zenith] Disconnected, notifying callback');
				if (this.fnDisconnect) fnDisconnect();
				//console.log('[zenith] Disconnected, reconnecting...');
				//this.try_reconnect(3);
			});

			this.ws.on('ping', (data, flags) => {
				console.log('[zenith] Received a ping, responding with pong');
				this.resetPingTimeout();
				this.ws.pong(data, null, false);
			});

			this.ws.on('message', this.ws_onMessage.bind(this));
		});
	}

	/// Disconnect from the WebSocket.
	disconnect() {
		if (this.debug) console.log('[zenith] Disconnecting');
		this.reconnect = false;
		if (this.pingTimer) clearTimeout(this.pingTimer);
		this.pingTimer = undefined;
		if (this.tokenTimer) clearTimeout(this.tokenTimer);
		this.tokenTimer = undefined;
		if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
		this.subscriptionTimer = undefined;
		this.ws.close();
	}

	/// Make a subscription array key from a request or response object.
	makeKey(obj) {
		return obj.Controller + ':' + obj.Topic;
	}

	ws_onMessage(data, flags) {
		// Received websocket message
		let jsonRes = JSON.parse(data);
		if (this.debug) console.log('\n-- Incoming Zenith message --\n', jsonRes, '\n----------------------\n');

		let key = null;
		if (jsonRes.TransactionID) {
			// Response to a pending 'action' call
			key = jsonRes.TransactionID;
		} else {
			// No transaction ID, a subscription message
			key = this.makeKey(jsonRes);
		}

		let d = this.pending[key];
		if (d) {
			// This is a match
			clearTimeout(d.failTimer);
			this.pending[key] = undefined;
			if ((jsonRes.Action == 'Error') || (jsonRes.Result == 'Error')) {
				d.reject(jsonRes.Data);
				return;
			} else {
				d.fulfill(jsonRes.Data);
			}
		}
		if (this.subscriptions[key]) {
			// Call each registered callback for this subscription
			this.subscriptions[key].forEach(cb => {
				cb(jsonRes.Data);
			});
		}
	}

	/// Start over the 30 second timeout before sending a ping.
	/**
	 * This function is called when we send or receive a message so that we don't
	 * bother sending a ping unless the connection has actually been idle for
	 * 30 seconds.
	 */
	/*private*/ resetPingTimeout() {
		if (this.pingTimer) clearTimeout(this.pingTimer);
		this.pingTimer = setTimeout(() => {
			this.ws.ping();
		}, PING_TIMEOUT_MS);
	}

	/// Check to see if there are any active subscriptions.
	/**
	 * If there are, set a timer to avoid the script terminating.  If there are no
	 * subscriptions then don't set the timer so the script will exit.
	 */
	/*private*/ subscriptionPing() {
		this.subscriptionTimer = setTimeout(() => {
			if (
				// Any active subscriptions?
				(this.subscriptions.length > 0)
				// Still connected to the server?
				&& this.pingTimer
			) {
				this.subscriptionPing();
			}
		}, SUB_PING_TIMEOUT_MS);
	}

	/// Send a non-subscription message.
	/**
	 * @pre Must be connected.
	 *
	 * @return Promise, then() param is message response from server.
	 *   On error, Promise is rejected with either WS error or ZenithError.
	 */
	z_call(controller, topic, params) {
		if (this.debug) console.log('[zenith] API call: ' + controller + ':' + topic);
		return new Promise((fulfill, reject) => {
			let req = {
				Controller: controller,
				Topic: topic,
				Data: params,
				Confirm: false,
				TransactionID: ++this.lastTransactionID,
				fulfill: fulfill,
				reject: reject,
			};
			this.pending[req.TransactionID] = req;
			//console.log('[' + req.TransactionID + '] ' + req.Controller + ':' + req.Topic);

			try {
				this.resetPingTimeout();
				this.ws.send(JSON.stringify(req), err => {
					if (err) reject(err);
					// Now waiting for response which will be sent to on_ws_message()
				});
				// Add a timer so the call fails if we don't get a response in time
				req.failTimer = setTimeout(() => {
					// Remove request from pending list
					this.pending[req.TransactionID] = undefined;

					req.reject(new ZenithError('TIMEOUT', 'No response to call'));
				}, CALL_TIMEOUT_MS);
			} catch (e) {
				reject(e);
			}
		});
	}

	/// Subscribe to a topic.
	/**
	 * After this, unsolicited topic updates will be received for the given
	 * topic.  Each unsolicited message will be passed to the supplied callback.
	 *
	 * @pre Must be connected.
	 *
	 * @return Promise, param is message response from server.
	 *
	 * @todo What happens if the connection drops out?  Do we need to resubscribe
	 *  or can we use the session re-establishment API call?
	 */
	z_subscribe(controller, topic, params, cb) {
		if (this.debug) console.log('[zenith] API subscription: ' + controller + ':' + topic);
		return new Promise((fulfill, reject) => {
			if (!cb) {
				reject(new TypeError('Missing callback function.'));
				return;
			}
			let req = {
				Controller: controller,
				Topic: topic,
				Action: 'Sub',
				Confirm: false,
				TransactionID: ++this.lastTransactionID,
				fulfill: fulfill,
				reject: reject,
			};

			let key = this.makeKey(req);
			if (!this.subscriptions[key]) this.subscriptions[key] = [];
			this.subscriptions[key].push(cb);

			// Set up the subscription timer.
			this.subscriptionPing();

			this.pending[key] = req;

			try {
				this.resetPingTimeout();
				//console.log('[Sub] ' + req.Controller + ':' + req.Topic);
				this.ws.send(JSON.stringify(req), err => {
					if (err) reject(err);
					// Now waiting for response which will be sent to on_ws_message()
					// Subscribed
					// TODO: Wait for subscription confirmation?
					//fulfill();
				});

				// Add a timer so the call fails if we don't get a response in time
				req.failTimer = setTimeout(() => {
					// Remove request from pending list
					this.pending[key] = undefined;

					req.reject(new ZenithError('TIMEOUT', 'No response to subscription request'));
				}, CALL_TIMEOUT_MS);
			} catch (e) {
				reject(e);
			}
		});
	}

	/// Zenith API: Authenticate with new/refreshed token.
	/**
	 * @note Called internally when the token timer expires and the token has
	 *   been refreshed.
	 */
	auth_authToken() {
		return this.z_call('Auth', 'AuthToken', {
			Provider: 'Bearer',
			AccessToken: this.token.accessToken,
		}).then(d => {
			if (d.Result != 'Success') {
				// TODO: Attempt complete re-login
				throw ZenithError('ACCESS_REVOKED', 'Token reauthentication failed.');
			}
		});
	}

	/// Zenith API: Identify logged in user.
	auth_queryIdentify() {
		return this.z_call('Auth', 'QueryIdentify');
	}

	/// Zenith API: List available markets.
	market_queryMarkets() {
		return this.z_call('Market', 'QueryMarkets');
	}

	/// Zenith API: Subscribe to market state changes (market_queryMarkets).
	sub_market_markets(cb) {
		return this.z_subscribe('Market', 'Markets', undefined, cb);
	}

	/// Zenith API: Subscribe to market state changes.
	sub_market_security(market, symbol, cb) {
		return this.z_subscribe('Market', 'Security!' + symbol + '.' + market, undefined, cb);
	}

	/// Zenith API: Subscribe to live trades notifications.
	sub_market_trades(market, symbol, cb) {
		return this.z_subscribe('Market', 'Trades!' + symbol + '.' + market,
			undefined, d => {
				// Convert any string dates into JS Date objects
				d.forEach(trade => {
					if (trade.Trade && trade.Trade.Time) {
						trade.Trade.Time = new Date(trade.Trade.Time);
					}
				});
				cb(d);
			});
	}

	/// Zenith API: Retrieve the current state of a security.
	/**
	 * @param string market
	 *   Market code.
	 *
	 * @param string code
	 *   Symbol code.
	 */
	market_querySecurity(market, code) {
		return this.z_call('Market', 'QuerySecurity', {
			Market: market,
			Code: code,
		});
	}

	market_querySymbols(market, text, options = {}) {
		options.Market = market;
		options.SearchText = text;
		return this.z_call('Market', 'QuerySymbols', options);
	}

	/// Zenith API: Cancel an order.
	trading_cancelOrder(account, order, options = {}) {
		options.Account = account;
		options.Order = order;
		return this.z_call('Trading', 'CancelOrder', options);
	}

	/// Zenith API: List available trading accounts.
	trading_queryAccounts() {
		return this.z_call('Trading', 'QueryAccounts');
	}

	/// Zenith API: List available balances.
	trading_queryBalances(account) {
		return this.z_call('Trading', 'QueryBalances', {
			Account: account,
		});
	}

	/// Zenith API: List owned stocks.
	trading_queryHoldings(account) {
		return this.z_call('Trading', 'QueryHoldings', {
			Account: account,
		});
	}

	/// Zenith API: List unfulfilled and recent orders.
	trading_queryOrders(account, order = undefined) {
		return this.z_call('Trading', 'QueryOrders', {
			Account: account,
			OrderID: order,
		});
	}

	/// Zenith API: Place an order.
	trading_placeOrder(options) {
		return this.z_call('Trading', 'PlaceOrder', options);
	}

	/// Zenith API: Get server info.
	zenith_serverInfo() {
		return new Promise((fulfill, reject) => {
			this.z_subscribe('Zenith', 'ServerInfo', undefined, d => {
				fulfill(d);
				// TODO: Unsubscribe!
			}).catch(err => reject(err));
		});
	}
};

module.exports = ZenithWS;
