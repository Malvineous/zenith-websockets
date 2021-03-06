'use strict';

// Command line tool for interfacing with Zenith
// Use -h for help.

var parseArgs = require('minimist');

let Zenith = require('./index.js');

let config = require('./test-config.js');

let idExchange = 'ASX[Demo]'; // overridden with -e

function checkError(result, action) {
	if (result.Result == 'Invalid') {
		console.log(action + ' invalid due to incorrect information supplied: '
			+ result.Errors.join(' '));
	} else if (result.Result == 'Rejected') {
		console.log(action + ' rejected based on: ' + result.Errors.join(' '));
	} else if (result.Result == 'Error') {
		console.log(action + ' failed due to parameters: '
			+ result.Errors.join(' '));
	} else {
		return false; // no error
	}
	return true; // error
}


class Actions
{
	constructor(zenith) {
		this.zenith = zenith;
	}

	list_accounts(promise, params) {
		if (!promise) {
			return [];
		}
		return promise.then(() => {
			return this.zenith.trading_queryAccounts()
				.then(accounts => {
					accounts.forEach(d => {
						console.log('account: id=' + d.ID + ' name=' + d.Name + ' currency=' + d.Currency);
					});
				});
		});
	}

	list_orders(promise, params) {
		if (!promise) {
			return ['account-id'];
		}

		let idAccount = params.shift();
		if (!idAccount) {
			throw Error('Need account ID to list orders.');
		}
		return promise.then(() => {
			return this.zenith.trading_queryOrders(idAccount)
				.then(orders => {
					if (orders.length == 0) {
						console.log('no current orders');
						return;
					}
					orders.forEach(order => {
						if (this.zenith.debug) console.log(order);
						/*
						{ O: 'A',
							Order:
							{ ID: '00000000-0000-0000-0010-5808838c0071',
								Account: '12345[Demo]',
								Style: 'Equity',
								ExternalID: '30A3C91_2',
								Status: 'Rejected',
								Currency: 'AUD',
								Market: 'ASX[Demo]',
								TradingMarket: 'ASX[Demo]',
								CurrentBrokerage: 0,
								EstimatedBrokerage: 0,
								CurrentTax: 0,
								EstimatedTax: 0,
								CurrentValue: 0,
								EstimatedValue: 0,
								CreatedDate: '2016-10-20T19:42:52+11:00',
								UpdatedDate: '2016-10-20T19:42:56+11:00',
								Route: { Algorithm: 'Market', Market: 'ASX[Demo]' },
								ExecutedQuantity: 0,
								Details:
								{ Style: 'Equity',
									Side: 'Bid',
									Exchange: 'ASX[Demo]',
									Code: 'BHP',
									BrokerageSchedule: 'OMR',
									Type: 'Market',
									Quantity: 100,
									Validity: 'FillOrKill' } } }
						 */
						let data = order.Order;
						console.log('order: id=' + data.ID
							+ ' status=' + data.Status
							+ ' side=' + data.Details.Side
							+ ' sym=' + data.Details.Code
							+ ' quantity=' + data.Details.Quantity
							+ ' limit=' + (data.Details.LimitPrice || 'N/A')
							+ ' valid=' + data.Details.Validity
						);
					});
				});
		});
	}

	cancel_order(promise, params) {
		if (!promise) {
			return ['account-id', 'order-id'];
		}

		let idAccount = params.shift();
		if (!idAccount) {
			throw Error('Need account ID of order to cancel.');
		}
		let idOrder = params.shift();
		if (!idOrder) {
			throw Error('Need order ID to cancel an order.');
		}
		return promise.then(() => {
			console.log('Cancelling order: account=' + idAccount + ' order=' + idOrder);
			return this.zenith.trading_cancelOrder(idAccount, idOrder)
				.then(result => {
					if (checkError(result, 'Order cancellation')) return;
					console.log(result);
				});
		});
	}

	query_holdings(promise, params) {
		if (!promise) {
			return ['account-id'];
		}

		let idAccount = params.shift();
		if (!idAccount) {
			throw Error('Need account ID to list holdings.');
		}
		return promise.then(() => {
			return this.zenith.trading_queryHoldings(idAccount)
				.then(holdings => {
					if (holdings.length == 0) {
						console.log('no current holdings');
						return;
					}
					holdings.forEach(holding => {
						if (this.zenith.debug) console.log(holding);
						/*
						{ O: 'A',
							Holding:
							{ Exchange: 'ASX[Demo]',
								Code: 'BHP',
								Account: '12345[Demo]',
								Style: 'Equity',
								Cost: 1973,
								Currency: 'AUD',
								TotalQuantity: 100,
								TotalAvailable: 100,
								AveragePrice: 19.73 } }
						 */
						let data = holding.Holding;
						console.log('holding: exchange=' + data.Exchange
							+ ' type=' + data.Style
							+ ' sym=' + data.Code
							+ ' quantity=' + data.TotalQuantity
							+ ' price=' + data.AveragePrice
							+ ' cost=' + data.Cost
						);
					});
				});
		});
	}

	query_markets(promise, params) {
		if (!promise) {
			return [];
		}

		return promise.then(() => {
			console.log('Querying markets:');
			return this.zenith.market_queryMarkets()
				.then(result => {
					if (checkError(result, 'Market query')) return;
					result.forEach(market => {
						console.log(market.Code
							+ ' feed=' + market.Feed
							+ ' status=' + market.Status);
						if (market.Feed == 'Initialising') {
							console.log(' * No data, feed is initialising');
						} else if (market.Status) {
							market.States.forEach(state => {
								console.log(' * ' + state.Name + ' status=' + state.Status);
							});
						} else {
							console.log(' * Missing market status:', market);
						}
					});
				});
		});
	}

	query_security(promise, params) {
		if (!promise) {
			return ['stock'];
		}

		let stock = params.shift();
		if (!stock) {
			throw Error('Need stock symbol to query.');
		}
		return promise.then(() => {
			console.log('Querying security: stock=' + stock);
			return this.zenith.market_querySecurity(idExchange, stock)
				.then(result => {
					if (checkError(result, 'Security query')) return;
					console.log(result);
				});
		});
	}

	buy_equity(promise, params) {
		if (!promise) {
			return ['account-id', 'market', 'stock', 'quantity'];
		}

		let idAccount = params.shift();
		if (!idAccount) {
			throw Error('Need account ID to place order through.');
		}
		let market = params.shift();
		if (!market) {
			throw Error('Need market to buy through.');
		}
		let stock = params.shift();
		if (!stock) {
			throw Error('Need stock to buy.');
		}
		let quantity = params.shift();
		if (!quantity) {
			throw Error('Need quantity to buy.');
		}
		return promise.then(() => {
			console.log('Buy equity: account=' + idAccount
				+ ' market=' + market
				+ ' stock=' + stock
				+ ' quantity=' + quantity
			);
			return this.zenith.trading_placeOrder({
				Account: idAccount,
				Details: {
					Exchange: idExchange,
					Code: stock,
					Side: 'Bid',
					Style: 'Equity',
					Type: 'Best',
					Quantity: quantity,
					Validity: 'UntilCancel',
				},
				Route: {
					Algorithm: 'Market',
					Market: market,
				},
			})
			.then(result => {
				if (checkError(result, 'Equity purchase')) return;
				console.log(result);
			});
		});
	}

	monitor(promise, params) {
		if (!promise) {
			return ['market', 'stock'];
		}

		let market = params.shift();
		if (!market) {
			throw Error('Need market where stock is located.');
		}
		let stock = params.shift();
		if (!stock) {
			throw Error('Need stock to monitor.');
		}
		return promise.then(() => {
			return zenith.sub_market_security(market, stock, d => {
				console.log('Security update: last=' + d.Last
					+ ' trade_count=' + d.NumberOfTrades
					+ ' volume=' + d.Volume
					+ ' value_traded=' + d.ValueTraded
					+ ' bid_count=' + d.BidCount
					+ ' bid_quantity=' + d.BidQuantity
				);
			});
		})
		.then(() => {
			return zenith.sub_market_trades(market, stock, updates => {
				updates.forEach(d => {
					if (d.O == 'I') {
						console.log('New trade: id=' + d.ID);
						return;
					}
					if (!d.Trade) {
						console.log('Unknown trade update:', d);
						return;
					}
					console.log('Trade update: update_type=' + d.O
						+ ' id=' + d.Trade.ID
						+ ' price=' + d.Trade.Price
						+ ' quantity=' + d.Trade.Quantity
						+ ' time=' + d.Trade.Time
						+ ' trend=' + d.Trade.Trend
						+ ' side=' + d.Trade.Ask
					);
				});
			});
		});
	}

	sell_equity(promise, params) {
		if (!promise) {
			return ['account-id', 'market', 'stock', 'quantity'];
		}

		let idAccount = params.shift();
		if (!idAccount) {
			throw Error('Need account ID to place order through.');
		}
		let market = params.shift();
		if (!market) {
			throw Error('Need market to sell through.');
		}
		let stock = params.shift();
		if (!stock) {
			throw Error('Need stock to sell.');
		}
		let quantity = params.shift();
		if (!quantity) {
			throw Error('Need quantity to sell.');
		}
		return promise.then(() => {
			console.log('Sell equity: account=' + idAccount
				+ ' market=' + market
				+ ' stock=' + stock
				+ ' quantity=' + quantity
			);
			return this.zenith.trading_placeOrder({
				Account: idAccount,
				Details: {
					Exchange: idExchange,
					Code: stock,
					Side: 'Ask',
					Style: 'Equity',
					Type: 'Best',
					Quantity: quantity,
					Validity: 'UntilCancel',
				},
				Route: {
					Algorithm: 'Market',
					Market: market,
				},
			})
			.then(result => {
				if (checkError(result, 'Equity purchase')) return;
				console.log(result);
			});
		});
	}
};

let args = parseArgs(process.argv.slice(2), {
	boolean: ['d', 'h'],
	string: ['e'],
});

if (args.h || (args._.length == 0)) { // help
	console.log('Command line interface to Zenith API.\n')
	console.log('Usage: node tool.js [options] action1 param1 action2 ...\n');
	console.log('Options:');
	console.log('  -d\tEnable debug mode (show more output)');
	console.log('  -e\tSet exchange to use, e.g. -e ASX[Demo]');
	console.log('\nActions:');
	Object.getOwnPropertyNames(Actions.prototype).sort().forEach(d => {
		if (d == 'constructor') return;
		console.log('  ' + d + '\t' + Actions.prototype[d]().join(' '));
	});
	process.exit(0);
}

if (args.e) {
	idExchange = args.e;
}
console.log('Using exchange "' + idExchange + '"');

let zenith = new Zenith.WebSockets(config);
if (args.d) zenith.debug = true;

let shouldExit = true;

zenith.connect().then(() => {
	let p = Promise.resolve();

	// Parse the command line and run the given jobs
	let actions = args._;
	let a = new Actions(zenith);
	while (actions.length) {
		let action = actions.shift().replace('-', '_');
		if (!a[action]) {
			console.log('Unknown action: ' + action);
			process.exit(1);
		}
		try {
			p = a[action](p, actions);
			if (action == 'monitor') shouldExit = false;
		} catch (e) {
			// Immediate error (e.g. missing params)
			console.log('Use: ' + action + ' ' + a[action]().join(' ') + '\n');
			console.log(action + ' error: ' + e.message);
			zenith.disconnect();
			process.exit(1);
		}
	}
	p.then(() => {
		if (shouldExit) zenith.disconnect();
	}).catch(err => {
		console.log('Error:', err);
		zenith.disconnect();
		process.exit(1);
	});
});
