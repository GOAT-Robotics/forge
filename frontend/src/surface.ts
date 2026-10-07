/**
 * What a part looks like in the realistic 3D view, from its specification: the coating or finish (powder coat
 * gloss level, paint, plating, anodising) and, where it is left bare, the material (stainless, aluminium, mild
 * steel, brass, plastics) with the machined surface roughness. Returns PBR parameters for MeshStandardMaterial.
 */
export type SurfaceLook = { color?: string; roughness: number; metalness: number; label: string };

const RA: [RegExp, number][] = [[/0\.[48]/, 0.18], [/1\.6/, 0.26], [/3\.2/, 0.36], [/6\.3/, 0.48], [/12\.5|25/, 0.62]];

export function surfaceLook(spec: Record<string, any>, category = ''): SurfaceLook {
  const fin = [spec.finish, spec.paint, spec.process].filter(Boolean).join(' ').toLowerCase();
  const mat = [spec.material, spec.stock].filter(Boolean).join(' ').toLowerCase();
  const hex = spec.coating_hex || undefined;
  const gloss = /high gloss|gloss(?!y?\s*matte)/.test(fin) && !/semi|matte|matt/.test(fin);
  if (/powder|paint|enamel|epoxy|\bpu\b|polyurethane|lacquer|coat/.test(fin) && !/zinc|plat|galv|anodi/.test(fin)) {
    const roughness = gloss ? 0.2 : /semi|satin/.test(fin) ? 0.4 : /textur|wrinkle|sand|structure/.test(fin) ? 0.86 : 0.62;
    const metalness = /metallic|9006|9007|silver|bronze/.test(fin + ' ' + (spec.coating_color || '').toLowerCase()) ? 0.55 : 0.02;
    return { color: hex, roughness, metalness, label: gloss ? 'gloss coat' : roughness > 0.8 ? 'textured coat' : 'matte coat' };
  }
  if (/anodi/.test(fin)) return { color: hex || (/black/.test(fin) ? '#1f2226' : '#c3c8ce'), roughness: 0.34, metalness: 0.55, label: 'anodised' };
  if (/hot.?dip|hdg/.test(fin)) return { color: '#a7aeb5', roughness: 0.55, metalness: 0.72, label: 'galvanised' };
  if (/zinc|plat|galvani|electro.?galv/.test(fin)) return { color: hex || (/yellow/.test(fin) ? '#d4bb6a' : /black/.test(fin) ? '#2c2f33' : '#cad1d8'), roughness: 0.3, metalness: 0.85, label: 'plated' };
  if (/chrome|nickel/.test(fin)) return { color: hex || '#d9dde1', roughness: 0.1, metalness: 1, label: 'bright plated' };
  if (/phosphat|black oxide|blacken|bluing/.test(fin)) return { color: hex || '#3a3d41', roughness: 0.6, metalness: 0.4, label: 'blackened' };
  // bare: the material itself, with the machined finish where given
  const ra = RA.find(([r]) => r.test(String(spec.roughness || '')))?.[1];
  const polish = /mirror|polish|no\.?\s*8|bright/.test(fin + ' ' + mat), brushed = /brush|no\.?\s*4|hairline|satin/.test(fin + ' ' + mat);
  if (/stainless|\bss\s?\d|ss304|ss316|304|316|430|sus/.test(mat)) return { color: hex || '#c8ccd1', roughness: polish ? 0.07 : brushed ? 0.3 : ra ?? 0.26, metalness: 1, label: 'stainless' };
  if (/alumin|\bal\b|50\d\d|60\d\d|70\d\d|1100|3003/.test(mat)) return { color: hex || '#d2d6db', roughness: polish ? 0.1 : ra ?? 0.36, metalness: 0.95, label: 'aluminium' };
  if (/brass|cuzn/.test(mat)) return { color: hex || '#c9a24e', roughness: ra ?? 0.28, metalness: 1, label: 'brass' };
  if (/copper|\bcu\b/.test(mat)) return { color: hex || '#c07a52', roughness: ra ?? 0.3, metalness: 1, label: 'copper' };
  if (/pom|acetal|delrin/.test(mat)) return { color: hex || '#f0efe9', roughness: 0.45, metalness: 0, label: 'acetal' };
  if (/nylon|pa6|polyamide/.test(mat)) return { color: hex || '#ebe5d4', roughness: 0.55, metalness: 0, label: 'nylon' };
  if (/abs|pla|petg|acrylic|pmma|polycarb|hdpe|uhmw|plastic|rubber/.test(mat)) return { color: hex, roughness: 0.5, metalness: 0, label: 'plastic' };
  if (/\bgi\b|\bgp\b|galvan|dx51/.test(mat)) return { color: hex || '#b9c0c7', roughness: 0.42, metalness: 0.82, label: 'galvanised sheet' };
  if (/hot rolled|\bhr\b|2062|e250|s235|s355/.test(mat)) return { color: hex || '#5d6166', roughness: 0.72, metalness: 0.55, label: 'hot-rolled steel' };
  if (/crca|cold rolled|\bcr\b|513|crc|en\s?\d|c45|steel|\bms\b|mild/.test(mat)) return { color: hex || '#a3a8ae', roughness: ra ?? 0.42, metalness: 0.85, label: 'bare steel' };
  return { color: hex, roughness: category === 'purchased' ? 0.5 : 0.48, metalness: category === 'purchased' ? 0.1 : 0.25, label: 'unspecified' };
}
