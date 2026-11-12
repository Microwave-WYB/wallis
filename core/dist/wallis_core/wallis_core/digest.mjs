/// <reference types="./digest.d.mts" />
import * as $bit_array from "../../gleam_stdlib/gleam/bit_array.mjs";
import * as $int from "../../gleam_stdlib/gleam/int.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import { remainderInt, bitArraySlice } from "../gleam.mjs";

const prime = 16_777_619;

const modulus = 4_294_967_296;

function pad(n) {
  return $string.pad_start($string.lowercase($int.to_base16(n)), 8, "0");
}

function xor32(a, b) {
  let x = $int.bitwise_exclusive_or(a, b);
  let $ = x < 0;
  if ($) {
    return x + modulus;
  } else {
    return x;
  }
}

function mul32(a, b) {
  let al = a % 65_536;
  let ah = globalThis.Math.trunc(a / 65_536);
  let bl = b % 65_536;
  let bh = globalThis.Math.trunc(b / 65_536);
  let high = (ah * bl + al * bh) % 65_536;
  return remainderInt((high * 65_536 + al * bl), modulus);
}

function lanes(loop$bytes, loop$a, loop$b) {
  while (true) {
    let bytes = loop$bytes;
    let a = loop$a;
    let b = loop$b;
    if (bytes.bitSize >= 8) {
      let byte = bytes.byteAt(0);
      let rest = bitArraySlice(bytes, 8);
      loop$bytes = rest;
      loop$a = mul32(xor32(a, byte), prime);
      loop$b = mul32(xor32(b, (byte + 0x9e) % 256), prime);
    } else {
      return [a, b];
    }
  }
}

export function hex(text) {
  let $ = lanes($bit_array.from_string(text), 2_166_136_261, 3_323_198_485);
  let a = $[0];
  let b = $[1];
  return pad(a) + pad(b);
}
