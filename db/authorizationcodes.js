var storage = require('../lib/store'),
    store = null;

storage.create('codes', function(err, obj){
    // TODO: check err
    store = obj;
});

exports.find = function(key, done){
    store.get(key, done);
};

exports.save = function(code, clientID, redirectURI, userID, scope, done){
    store.put(code, {clientID: clientID, redirectURI: redirectURI, userID: userID, scope: scope}, done);
};

exports.del = function(key, done){
    store.del(key, done);
}
