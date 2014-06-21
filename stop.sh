#!/bin/bash

function stopf(){
    APP=$1
    PIDFILE=$APP.pid

    test -e $PIDFILE && pkill -F $PIDFILE && echo "stopping $APP"
    rm -f $PIDFILE
}

stopf ./src/server.js
stopf ./dummy-servers/resource-server.js
