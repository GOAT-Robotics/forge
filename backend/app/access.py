"""Role-based access control.

Global roles (users.role) give the default permissions everywhere; a project membership (project_members)
replaces them inside that project. Vendors (share links) are always read-only.
"""
import json
from fastapi import HTTPException, Request
from . import db

PERMISSIONS = {
    'project.create': 'Create projects',
    'project.settings': 'Change project settings, members and rules',
    'revision.upload': 'Upload CAD revisions',
    'part.edit': 'Edit part category, specification, process and joints',
    'drawing.edit': 'Arrange drawings (views, callouts, notes)',
    'drawing.review': 'Mark part drawings reviewed',
    'design.review': 'Record design-check dispositions and approvals',
    'revision.release': 'Mark a revision production ready',
    'joborder.create': 'Create and edit job orders',
    'joborder.update': 'Record production / process progress',
    'qc.record': 'Record inspections',
    'qc.plan': 'Plan inspection: balloons, critical characteristics, limits, nonconformance disposition',
    'cad.download': 'Download STEP / DXF files',
    'share.manage': 'Create and revoke vendor links',
    'templates.manage': 'Manage process and drawing templates',
    'users.manage': 'Manage users and roles',
}
ALL = set(PERMISSIONS)
ENGINEER = ALL - {'users.manage'}
ROLES = {
    'admin': ('Administrator', ALL),
    'engineer': ('Design engineer', ENGINEER),
    'reviewer': ('Design reviewer', {'drawing.review', 'design.review', 'drawing.edit'}),
    'production': ('Production planner', {'joborder.create', 'joborder.update', 'qc.record'}),
    'operator': ('Shop floor operator', {'joborder.update'}),
    'qc': ('Quality inspector', {'qc.record', 'qc.plan', 'joborder.update'}),
    'viewer': ('Viewer (read only)', set()),
}
ALIASES = {'owner': 'admin'}  # installations created before RBAC
PROJECT_ROLES = ('engineer', 'reviewer', 'production', 'operator', 'qc', 'viewer')


def role_of(u):
    return ALIASES.get(u.get('role'), u.get('role'))


def perms_for(u, project_id=None):
    if not u or u.get('role') == 'vendor':
        return set()
    role = role_of(u)
    if role == 'admin':
        return set(ALL)
    if project_id:
        m = db.row('SELECT role FROM project_members WHERE project_id=? AND user_id=?', (project_id, u['id']))
        if m:
            return set(ROLES.get(m['role'], ('', set()))[1])
    return set(ROLES.get(role, ('', set()))[1])


def can(u, perm, project_id=None):
    return perm in perms_for(u, project_id)


def require(u, perm, project_id=None):
    if u.get('role') == 'vendor':
        raise HTTPException(403, 'Vendor links are read-only')
    if not can(u, perm, project_id):
        raise HTTPException(403, f"Permission required: {PERMISSIONS.get(perm, perm)}")
    return u


def project_of_revision(rid):
    r = db.row('SELECT project_id FROM revisions WHERE id=?', (rid,))
    return r['project_id'] if r else None


def roles_payload():
    return {'roles': [{'id': k, 'label': v[0], 'permissions': sorted(v[1])} for k, v in ROLES.items()],
            'permissions': PERMISSIONS, 'project_roles': list(PROJECT_ROLES)}
