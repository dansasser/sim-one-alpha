import { add, Calculator } from './calc.js';

const calc = new Calculator(10);
const result = add(calc.plus(5), 3);
console.log(result);
