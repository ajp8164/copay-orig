'use strict';

angular.module('copayApp.api').service('getSessionVar', function(lodash, appletSessionService) {

	var root = {};

  root.respond = function(message, callback) {
	  // Request parameters.
    var sessionId = message.request.params.id;
    var name = message.request.params.name;

  	if (lodash.isUndefined(sessionId) || sessionId.length <= 0) {
	    message.response = {
	      statusCode: 400,
	      statusText: 'The request must include a session id.',
	      data: {}
	    };
			return callback(message);
  	}

		// Get the session.
		var session = appletSessionService.getSession(sessionId);

		if (lodash.isUndefined(session)) {
	    message.response = {
	      statusCode: 404,
	      statusText: 'Session not found.',
	      data: {}
	    };
			return callback(message);
		}

		try {
	    message.response = {
	      statusCode: 200,
	      statusText: 'OK',
	      data: {
	      	value: session.get(name)
	      }
	    };

		} catch (error) {

	    message.response = {
	      statusCode: 500,
	      statusText: error.message,
	      data: {}
	    };
		}

		return callback(message);
	};

  return root;
});
