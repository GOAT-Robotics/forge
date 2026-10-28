"""Preparation defaults: recover known values without inventing engineering decisions."""
FIELDS = ('material', 'process', 'finish', 'general_tolerance', 'datums')


def prepare_spec(part, settings, fill):
    spec = {**part['spec']}
    defaults = {'general_tolerance': (settings.get('conventions') or {}).get('general_tolerance', '')}
    defaults['material'] = (part['geometry'].get('cad') or {}).get('material') or (part['geometry'].get('step') or {}).get('material', '')
    operations = spec.get('operations') or []
    if operations:
        defaults['process'] = ' + '.join(o.get('name', '') for o in operations if isinstance(o, dict) and o.get('name'))
    # User input wins over project/CAD defaults, but never replaces an existing specification.
    for key, value in {**defaults, **{k: v for k, v in fill.items() if v.strip()}}.items():
        if key in FIELDS and value.strip() and not str(spec.get(key) or '').strip():
            spec[key] = value.strip()
    return spec


def missing_details(part):
    return [key for key in FIELDS if not str(part['spec'].get(key) or '').strip()]
