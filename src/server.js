require('daemon')();

var cluster = require('cluster');

if (cluster.isMaster){
    require('./server-master').run();
}else{
    require('./server-worker').run();
}
