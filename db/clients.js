var fs = require('fs'),
    log = require('../lib/logging.js').log,
    config = require('../lib/config');

var clients = [];

function reload(){
    var filename = config.get('client_credentials').file;
    try{
        clients = JSON.parse(fs.readFileSync(filename));
        clients.forEach(function(c){
            log('debug', 'Loaded client ' + c.name);
        });
    }catch(ex){
        log('error', "Fatal: Can't read Client JSON file " + filename + ': ' + ex);
        process.exit(1);
    }
}

config.on('loaded', reload);

exports.list = function(){
    var r = [];
    clients.forEach(function(c){
        r.push({id: c.id, name: c.name});
    });
    return r;
}

exports.find = function(id, done){
    for (var i = 0, len = clients.length; i < len; i++){
        var client = clients[i];
        if (client.id === id){
            return done(null, client);
        }
    }
    return done(null, null);
};

exports.findByClientId = function(client_id, done){
    for (var i = 0, len = clients.length; i < len; i++){
        var client = clients[i];
        if (client.client_id === client_id){
            return done(null, client);
        }
    }
    return done(null, null);
};

