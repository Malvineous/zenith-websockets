'use strict';

class ZenithError extends Error
{
	constructor(code, message) {
		super(message);
		this.message = message;
		this.name = 'ZenithError';
		this.code = code;
	}
};

module.exports = ZenithError;
