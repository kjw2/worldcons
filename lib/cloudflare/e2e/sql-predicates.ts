/** D1 limits expression depth to 100; preserve comparison/binding order. */
export function allPredicates(predicates:readonly string[]):string {
  if (!predicates.length) return "1";
  if (predicates.length===1) return predicates[0];
  const middle=Math.floor(predicates.length/2);
  return `(${allPredicates(predicates.slice(0,middle))} AND ${allPredicates(predicates.slice(middle))})`;
}
