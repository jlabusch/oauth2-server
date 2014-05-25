#!/bin/bash

export NODE_CONFIG_DIR=${NODE_CONFIG_DIR:=config}
export NODE_ENV=${NODE_ENV:=development}

echo "Environment: $NODE_ENV"

function startf(){
    APP=$1
    PIDFILE=$APP.pid

    echo "node $APP"
    test -e $PIDFILE && echo "Not starting; $PIDFILE exists." >&2 || node $APP
}

startf ./dummy-servers/MemStore-server.js # this is a no-op unless "MemStore" is a configured storage type.
startf ./dummy-servers/resource-server.js # this is a no-op unless resource_server.type is "dummy"
startf ./src/server.js

