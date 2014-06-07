// Return a unique identifier with the given `len`.
//
//     utils.uid(10);
//     // => "FDaS435D2z"
exports.uid = function(len){
    var buf = [],
        chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        charlen = chars.length;

    for (var i = 0; i < len; ++i){
        buf.push(chars[getRandomInt(0, charlen - 1)]);
    }

    return buf.join('');
};

// Return a random int, used by `utils.uid()`
function getRandomInt(min, max){
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

exports.prepender = function(prefix){
    return function(str){
        return prefix + str;
    }
}

