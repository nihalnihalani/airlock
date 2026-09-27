// Bun imports these with `with { type: "text" }` (bundled into the Docker build as strings).
declare module "*.csv" {
  const text: string;
  export default text;
}
