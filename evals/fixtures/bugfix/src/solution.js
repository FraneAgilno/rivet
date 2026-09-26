export function countInRange(values, minimum, maximum) {
  return values.filter(value => value > minimum && value < maximum).length;
}
