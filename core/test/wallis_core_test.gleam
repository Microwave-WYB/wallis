import gleeunit

pub fn main() -> Nil {
  gleeunit.main()
}

// Toolchain smoke test; remove when the first real core test lands.
pub fn toolchain_test() {
  assert 1 + 1 == 2
}
