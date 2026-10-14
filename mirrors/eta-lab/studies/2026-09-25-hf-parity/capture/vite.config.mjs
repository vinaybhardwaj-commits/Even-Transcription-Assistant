// The shipped app dir is the alias target: "@" = THIS config's sibling app/ (a92ebae lib closure).
// A plain-object config: no vite import needed (the payload has no node_modules).
export default { resolve: { alias: { "@": new URL("./app/", import.meta.url).pathname } } };
