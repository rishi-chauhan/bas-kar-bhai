// Tiny DOM helpers shared by the extension pages.

export const $ = (id) => document.getElementById(id);

export function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
