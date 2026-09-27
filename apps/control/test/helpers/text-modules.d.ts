// The fixtures service (imported by test/helpers/forms.ts) bundles its CSV data as text modules.
declare module "*.csv" {
  const text: string;
  export default text;
}
