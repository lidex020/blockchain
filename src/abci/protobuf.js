'use strict';

const fs = require('node:fs');
const path = require('node:path');
const protobuf = require('protobufjs');

const schema = protobuf.parse(fs.readFileSync(path.join(__dirname, 'types.proto'), 'utf8'), undefined, {
  keepCase: true,
}).root;

const Request = schema.lookupType('tendermint.abci.Request');
const Response = schema.lookupType('tendermint.abci.Response');

function encodeVarint(value) {
  let n = BigInt(value);
  if (n < 0n) throw new RangeError('protobuf frame length cannot be negative');
  const bytes = [];
  while (n > 0x7fn) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function decodeVarint(buffer, offset = 0, maxBytes = 5) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < maxBytes; i++) {
    if (offset + i >= buffer.length) return null;
    const byte = buffer[offset + i];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new RangeError('protobuf frame length exceeds the safe integer range');
      return { value, bytes: i + 1 };
    }
    shift += 7;
  }
  throw new Error('protobuf frame length prefix is malformed or too large');
}

function encodeFrame(messageType, message) {
  const converted = messageType.fromObject(message);
  const error = messageType.verify(converted);
  if (error) throw new TypeError(`invalid protobuf message: ${error}`);
  const bytes = messageType.encode(converted).finish();
  return Buffer.concat([encodeVarint(bytes.length), Buffer.from(bytes)]);
}

function decodeRequest(bytes) {
  return Request.toObject(Request.decode(bytes), {
    bytes: Buffer,
    longs: String,
    enums: Number,
    defaults: false,
    oneofs: false,
  });
}

function encodeResponse(value) {
  return encodeFrame(Response, value);
}

function decodeResponse(bytes) {
  return Response.toObject(Response.decode(bytes), {
    bytes: Buffer,
    longs: String,
    enums: Number,
    defaults: false,
    oneofs: false,
  });
}

function requestFrame(value) {
  return encodeFrame(Request, value);
}

function responseType() {
  return Response;
}

function requestType() {
  return Request;
}

module.exports = {
  Request,
  Response,
  decodeRequest,
  decodeResponse,
  decodeVarint,
  encodeFrame,
  encodeResponse,
  encodeVarint,
  requestFrame,
  requestType,
  responseType,
};
