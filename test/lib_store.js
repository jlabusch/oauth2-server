var assert  = require('assert'),
    config  = require('../lib/config'),
    storage = require('../lib/store'),
    should  = require('should');

function introduce_lag(obj){
    obj.__raw_client = obj.__client;
    function slow(fname){
        return function(){
            var args = Array.prototype.slice.call(arguments, 0);
            setTimeout(function(){ obj.__raw_client[fname].apply(obj.__raw_client, args) }, 50);
        }
    }
    obj.__client = [
        'query',
        'set',
        'setex',
        'get',
        'mget',
        'del'
    ].reduce(function(r, f){ r[f] = slow(f); return r;}, {});
}

describe('Storage', function(){
    var pg_table = 'test_postgres',
        redis_table = 'test_redis';
    describe('setup', function(){
        it('should clean out ' + pg_table, function(done){
            this.timeout(5000);
            storage.create(pg_table, function(err, store){
                should.not.exist(err);
                // wait for pg_reconnect to finish
                setTimeout(function(){
                    store.__client.query('delete from ' + pg_table, function(err){
                        should.not.exist(err);
                        done();
                    });
                }, 500);
            });
        });
        it('should clean out ' + redis_table, function(done){
            storage.create(redis_table, function(err, store){
                should.not.exist(err);
                store.__client.flushall();
                done();
            });
        });
    });
    describe('Postgres', function(){
        var pg_store = null;
        it('should create a store', function(done){
            this.timeout(5000);
            pg_store = storage.create(pg_table, function(err, store){
                should.not.exist(err);
                should.exist(store);
                store.__table.should.equal(pg_table);
                pg_store = store;
                introduce_lag(pg_store);
                done();
            });
        });
        function check_pg_rows(preds, data){
            should.exist(data.rows);
            data.rowCount.should.equal(preds.length);
            data.rows.length.should.equal(preds.length);
            preds.forEach(function(p, i){
                var v = null;
                try{
                    v = JSON.parse(data.rows[i].value);
                }catch(ex){
                    should.not.exist(ex);
                }
                if (typeof(p) === 'function'){
                    p(v).should.be.true;
                }else{
                    (p === v).should.be.true;
                }
            });
        }
        it('should support put(key, value)', function(done){
            pg_store.put('simple put', 'hello world', function(err){
                should.not.exist(err);
                pg_store.__raw_client.query('select * from ' + pg_table + ' where key=\'simple put\'', function(err, data){
                    should.not.exist(err);
                    should.exist(data);
                    check_pg_rows(['hello world'], data);
                    done();
                });
            });
        });
        it('should support concurrent put()', function(done){
            pg_store.put('concurrent put', 'hello world', function(err){
                should.not.exist(err);
                pg_store.__raw_client.query('select value from ' + pg_table + " where key='concurrent put'", function(err, data){
                    should.not.exist(err);
                    should.exist(data);
                    check_pg_rows([function(v){ return v === 'hello world' || v === 'goodbye world' }], data);
                });
            });
            pg_store.put('concurrent put', 'goodbye world', function(err){
                should.not.exist(err);
                pg_store.__raw_client.query('select value from ' + pg_table + " where key='concurrent put'", function(err, data){
                    should.not.exist(err);
                    should.exist(data);
                    check_pg_rows([function(v){ return v === 'hello world' || v === 'goodbye world' }], data);
                    done();
                });
            });
        });
        it('should be updating values for put()', function(done){
            pg_store.__raw_client.query('select count(*) from ' + pg_table + " where key='concurrent put'", function(err, data){
                should.not.exist(err);
                should.exist(data);
                data.rowCount.should.equal(1);
                data.rows[0].count.should.equal('1');
                done();
            });
        });
        it('should support append(key, value)', function(done){
            pg_store.append('append 1', 'hello world', function(err){
                should.not.exist(err);
                pg_store.append('append 1', 'goodbye world', function(err){
                    should.not.exist(err);
                    pg_store.__raw_client.query('select value from ' + pg_table + " where key='append 1' order by mtime", function(err, data){
                        should.not.exist(err);
                        should.exist(data);
                        check_pg_rows(['hello world', 'goodbye world'], data);
                        done();
                    });
                });
            });
        });
        it('should support concurrent append()', function(done){
            function pred(v){
                return v.match(/^(hello|goodbye)( again)? world$/) !== null;
            }
            pg_store.append('append 2', 'hello world', function(err){
                should.not.exist(err);
                pg_store.append('append 2', 'goodbye world', function(err){
                    should.not.exist(err);
                });
            });
            pg_store.append('append 2', 'hello again world', function(err){
                should.not.exist(err);
                pg_store.append('append 2', 'goodbye again world', function(err){
                    should.not.exist(err);
                    setTimeout(function(){
                        pg_store.__raw_client.query('select value from ' + pg_table + " where key='append 2' order by mtime", function(err, data){
                            should.not.exist(err);
                            should.exist(data);
                            check_pg_rows([pred, pred, pred, pred], data);
                            done();
                        });
                    }, 500);
                });
            });
        });
        it('should support get(key)', function(done){
            pg_store.get('simple put', function(err, result){
                should.not.exist(err);
                ('hello world' === result).should.be.true;
                pg_store.get("I don't exist", function(err, result){
                    should.not.exist(err);
                    (result === null).should.be.true;
                    done();
                });
            });
        });
        it('should support get([keys])', function(done){
            pg_store.get(['simple put', 'concurrent put'], function(err, result){
                should.not.exist(err);
                result.length.should.equal(2);
                ('hello world' === result[0] || 'goodbye world' === result[0]).should.be.true;
                ('hello world' === result[1] || 'goodbye world' === result[1]).should.be.true;
                pg_store.get(["I don't exist", "either"], function(err, result){
                    should.not.exist(err);
                    (result && Array.isArray(result) && result.length === 0).should.be.true;
                    done();
                });
            });
        });
        it('should support concurrent get()', function(done){
            var done_1 = false,
                done_2 = false;
            pg_store.get('simple put', function(err, result){
                should.not.exist(err);
                ('hello world' === result).should.be.true;
                done_1 = true;
                if (done_1 && done_2){
                    done();
                }
            });
            pg_store.get('concurrent put', function(err, result){
                should.not.exist(err);
                ('hello world' === result || 'goodbye world' === result).should.be.true;
                done_2 = true;
                if (done_1 && done_2){
                    done();
                }
            });
        });
        it('should support del(key)', function(done){
            pg_store.del('simple put', function(err){
                should.not.exist(err);
                pg_store.get('simple put', function(err, result){
                    should.not.exist(err);
                    (result === null).should.be.true;
                    done();
                });
            });
        });
        it('should support concurrent del()', function(done){
            var done_1 = false,
                done_2 = false;
            pg_store.del('append 1', function(err){
                should.not.exist(err);
                pg_store.get('append 1', function(err, result){
                    should.not.exist(err);
                    (result === null).should.be.true;
                    done_1 = true;
                    if (done_1 && done_2){
                        done();
                    }
                });
            });
            pg_store.del('append 2', function(err){
                should.not.exist(err);
                pg_store.get('append 2', function(err, result){
                    should.not.exist(err);
                    (result === null).should.be.true;
                    done_2 = true;
                    if (done_1 && done_2){
                        done();
                    }
                });
            });
        });
    });
    describe('Redis', function(){
        var redis_store = null;
        it('should create a store', function(done){
            this.timeout(5000);
            redis_store = storage.create(redis_table, function(err, store){
                should.not.exist(err);
                should.exist(store);
                store.__table.should.equal(redis_table);
                redis_store = store;
                introduce_lag(redis_store);
                done();
            });
        });
        it('should support put(key, value)', function(done){
            redis_store.put('abc', 'def', function(err){
                should.not.exist(err);
                redis_store.get('abc', function(err, result){
                    should.not.exist(err);
                    (result === 'def').should.be.true;
                    done();
                });
            });
        });
        it('should support concurrent put()', function(done){
            var done_1 = false,
                done_2 = false;
            redis_store.put('pqr', '123', function(err){
                should.not.exist(err);
                redis_store.get('pqr', function(err, result){
                    should.not.exist(err);
                    (result === '123' || result === '456').should.be.true;
                    done_1 = true;
                    if (done_1 && done_2){
                        done();
                    }
                });
            });
            redis_store.put('pqr', '456', function(err){
                should.not.exist(err);
                redis_store.get('pqr', function(err, result){
                    should.not.exist(err);
                    (result === '123' || result === '456').should.be.true;
                    done_2 = true;
                    if (done_1 && done_2){
                        done();
                    }
                });
            });
        });
        it('should support append(key, value)');
        it('should support concurrent append()');
        it('should be adding rows for append()');
        it('should support get(key)', function(done){
            redis_store.get('abc', function(err, result){
                should.not.exist(err);
                (result === 'def').should.be.true;
                redis_store.get("I don't exist", function(err, result){
                    should.not.exist(err);
                    (result === null).should.be.true;
                    done();
                });
            });
        });
        it('should support get([keys])', function(done){
            redis_store.get(['abc', 'pqr'], function(err, result){
                should.not.exist(err);
                should.exist(result);
                result.length.should.equal(2);
                (result[0] === 'def').should.be.true;
                (result[1] === '123' || result[1] === '456').should.be.true;
                redis_store.get(["I don't exist", "either"], function(err, result){
                    should.not.exist(err);
                    (result && Array.isArray(result) && result.length === 0).should.be.true;
                    done();
                });
            });
        });
        it('should support concurrent get()', function(done){
            var done_1 = false,
                done_2 = false;
            redis_store.get('abc', function(err, result){
                should.not.exist(err);
                (result === 'def').should.be.true;
                done_1 = true;
                if (done_1 && done_2){
                    done();
                }
            });
            redis_store.get('pqr', function(err, result){
                should.not.exist(err);
                (result === '123' || result === '456').should.be.true;
                done_2 = true;
                if (done_1 && done_2){
                    done();
                }
            });
        });
        it('should support del(key)', function(done){
            redis_store.del('pqr', function(err){
                should.not.exist(err);
                redis_store.get('pqr', function(err, result){
                    should.not.exist(err);
                    (result === null).should.be.true;
                    done();
                });
            });
        });
        it('should support concurrent del()');
    });
});

