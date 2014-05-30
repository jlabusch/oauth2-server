var storage = require('../lib/store'),
    store = null,
    log = require('../lib/logging').log;

storage.create('tokens', function(err, obj){
    // TODO: check err
    store = obj;
});

function index_key(u, c){
    return 'u:' + u + ':c:' + c;
}

exports.find = function(token, done){
    store.get(token, done);
};

exports.find_by_user = function(userID, clientID, done){
    store.get(index_key(userID, clientID), done);
};

exports.save = function(token, userID, clientID, done){
    store.put(token, {userID: userID, clientID: clientID}, function(err){
        if (err){
            return done(err);
        }
        store.put('u:' + userID + ':c:' + clientID, token, done);
    });
};

exports.revoke = function(userID, clientID, done){
    var reverse_lookup = index_key(userID, clientID);
    store.get(reverse_lookup, function(err, token){
        if (err){
            return done(err);
        }
        if (!token){
            return done();
        }
        store.del(reverse_lookup, function(err){
            if (err){
                // don't care...
            }
            store.del(token, done);
        });
    });
};

