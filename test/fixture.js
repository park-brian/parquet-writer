export const schema = { fields: [
  { name: 'id', type: 'int32', nullable: false },
  { name: 'value', type: 'double', nullable: false },
  { name: 'label', type: 'string', nullable: false },
] }

export const rows = Array.from({ length: 40 }, (_, id) => ({
  id, value: id + 0.5, label: 'café 🌍',
}))
