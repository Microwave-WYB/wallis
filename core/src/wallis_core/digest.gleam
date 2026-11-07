//// A small, pure, non-cryptographic content digest (two FNV-1a lanes,
//// 64 bits total). It keys the journal and detects path divergence; it is
//// not a security boundary. Integers stay below 2^53 so the arithmetic is
//// exact on the JavaScript target.

import gleam/bit_array
import gleam/int
import gleam/string

const modulus = 4_294_967_296

const prime = 16_777_619

pub fn hex(text: String) -> String {
  let #(a, b) = lanes(bit_array.from_string(text), 2_166_136_261, 3_323_198_485)
  pad(a) <> pad(b)
}

fn lanes(bytes: BitArray, a: Int, b: Int) -> #(Int, Int) {
  case bytes {
    <<byte, rest:bits>> ->
      lanes(
        rest,
        mul32(xor32(a, byte), prime),
        mul32(xor32(b, { byte + 0x9e } % 256), prime),
      )
    _ -> #(a, b)
  }
}

fn xor32(a: Int, b: Int) -> Int {
  let x = int.bitwise_exclusive_or(a, b)
  case x < 0 {
    True -> x + modulus
    False -> x
  }
}

fn mul32(a: Int, b: Int) -> Int {
  let al = a % 65_536
  let ah = a / 65_536
  let bl = b % 65_536
  let bh = b / 65_536
  let high = { ah * bl + al * bh } % 65_536
  { high * 65_536 + al * bl } % modulus
}

fn pad(n: Int) -> String {
  string.pad_start(string.lowercase(int.to_base16(n)), 8, "0")
}
