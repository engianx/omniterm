declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Vite's `?url` import suffix resolves an asset to its served URL string
// (used for the pdf.js worker). Vite emits the asset as a hashed file under
// /assets and returns its URL.
declare module '*?url' {
  const src: string;
  export default src;
}
