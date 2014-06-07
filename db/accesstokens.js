var storage = require('../lib/store'),
    store = null,
    clients = require('../db/clients'),
    prepender = require('../lib/utils').prepender,
    log = require('../lib/logging').log;

storage.create('tokens', function(err, obj){
    // TODO: check err
    store = obj;
});

function index_key(u, c){
    return 'u:' + u + ':c:' + (c?c:'');
}

exports.expires_in = function(){
    return store.__config.ttl;
};

exports.find = function(token, done){
    store.get(token, done);
};

exports.find_by_user = function(userID, clientID, done){
    if (clientID){
        store.get(index_key(userID, clientID), done);
    }else{
        // Get the tokens for all clients
        store.get(clients.list().map(prepender(index_key(userID))), done);
    }
};

exports.save = function(token, userID, clientID, scope, done){
    store.put(token, {userID: userID, clientID: clientID, scope: scope}, function(err){
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

