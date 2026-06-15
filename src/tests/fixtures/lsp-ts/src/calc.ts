export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export class Calculator {
  constructor(private value: number) {}

  public plus(x: number): number {
    return add(this.value, x);
  }
}
