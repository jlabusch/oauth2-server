var storage = require('../lib/store'),
    store = null,
    log = require('../lib/logging').log;

storage.create('audit', function(err, obj){
    // TODO: check err
    store = obj;
});

exports.record = function(type, userID, clientID, data, done){
    store.put(userID + ':' + clientID + ':' + type, data, done);
};
