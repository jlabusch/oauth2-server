var storage = require('../lib/store'),
    store = null,
    log = require('../lib/logging').log;

storage.create('users', function(err, obj){
    // TODO: check err
    store = obj;
});

// We only store the user details that come back from the
// login response so that we can personalize the authorization form.

exports.add = function(id, data){
    store.put(id, data, function(err){
        if (err){
            log('warn', 'Error while saving user ' + id + ' data ' + JSON.stringify(data));
        }
    });
}

exports.find = function(id, done){
    store.get(id, done);
}

exports.findByUsername = function(username, done){
    throw 'Unsupported';
}

