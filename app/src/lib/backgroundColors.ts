export const BACKGROUND_COLORS = [
  { name: 'default', value: null },
  { name: 'red', value: '#f28b82' },
  { name: 'orange', value: '#fbbc04' },
  { name: 'yellow', value: '#fff475' },
  { name: 'green', value: '#ccff90' },
  { name: 'teal', value: '#a7ffeb' },
  { name: 'light-blue', value: '#cbf0f8' },
  { name: 'blue', value: '#aecbfa' },
  { name: 'purple', value: '#d7aefb' },
  { name: 'pink', value: '#fdcfe8' },
  { name: 'brown', value: '#e6c9a8' },
  { name: 'gray', value: '#e8eaed' },
] as const;

export type BackgroundColor = typeof BACKGROUND_COLORS[number]['value'];
