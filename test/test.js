/*jshint esversion: 6 */

const fs = require("fs");
const expect = require('chai').expect;
const parser = require('../parser.js');

describe('parser.js', function () {
    it('parser version 6', function () {
        var result = parser.VERSION;
        expect(result).to.be.equal(6);
    });

});
