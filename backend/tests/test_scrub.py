import re
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from app.scrub import scrub, clean_name, scrub_step


def sw_step(tmp_path):
    """A small STEP written by OCC, then dressed up the way SolidWorks exports look."""
    from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
    w = STEPControl_Writer()
    w.Transfer(BRepPrimAPI_MakeBox(10, 20, 3).Shape(), STEPControl_AsIs)
    raw = tmp_path / 'raw.step'
    w.Write(str(raw))
    t = raw.read_text()
    t = re.sub(r"'Open CASCADE STEP translator [^']*'", "'_ISO11GT-SM-046-SMPS PLATET2CC'", t)
    t = re.sub(r"FILE_NAME\(.*?\);", "FILE_NAME('C:\\\\Users\\\\naveen\\\\Desktop\\\\GT400 FINAL.STEP','2026-10-01T13:32:50',('naveen'),('GOAT'),'SwSTEP 2.0','SolidWorks 2026','');", t, flags=re.S)
    t = re.sub(r"MANIFOLD_SOLID_BREP\('[^']*'", "MANIFOLD_SOLID_BREP('Boss-Extrude2'", t)
    extra = ("#900001 = PERSON('naveen','Naveen','K',$,$,$);\n"
             "#900002 = ORGANIZATION('GOAT','GOAT Robotics','');\n"
             "#900003 = DESCRIPTIVE_REPRESENTATION_ITEM('SW-Author','naveen');\n"
             "#900004 = DESCRIPTIVE_REPRESENTATION_ITEM('SW-Material','AISI 304');\n"
             "#900005 = DESCRIPTIVE_REPRESENTATION_ITEM('Description','see \\\\\\\\fileserver\\\\cad\\\\gt400\\\\plate.SLDPRT');\n"
             "#900006 = DESCRIPTIVE_REPRESENTATION_ITEM('Document','{3F2504E0-4F89-11D3-9A0C-0305E82C3301} by naveen@goat-robotics.com');\n")
    t = t.replace('ENDSEC;\nEND-ISO', extra + 'ENDSEC;\nEND-ISO')
    src = tmp_path / 'source.step'
    src.write_text(t)
    return src


def test_names_lose_solidworks_noise_but_keep_part_numbers():
    assert clean_name('_ISO11GT-SM-046-SMPS PLATET2CC') == 'GT-SM-046-SMPS PLATE'
    assert clean_name('Mirror1111GT-MC-013-BACK CASTER MOUNT PLATET2CC') == 'GT-MC-013-BACK CASTER MOUNT PLATE (MIRROR)'
    assert clean_name('1DRIVE WHEEL ASM^GT_SWING_SETUP_LEFT_LH') == 'DRIVE WHEEL ASM'
    assert clean_name('_ISO1148V 30Ah FULL ASSEMBLY.STEPt1T2CC') == '48V 30Ah FULL ASSEMBLY.STEP'
    for keep in ('RGB CASE11', 'GT_2+4_MALE', 'HS1.stp', '1ST STAGE PLATE', '1100 BRACKET', 'ABCC', 'GT-250'):
        assert clean_name(keep) == keep


def test_step_upload_is_sanitized_and_still_reads(tmp_path):
    from app.cad import import_model, step_header, step_materials
    src = sw_step(tmp_path)
    rep = scrub(src)
    assert rep['solidworks'] and rep['header'] and rep['names'] >= 1 and rep['bodies'] == 1 and rep['people'] >= 2 and rep['properties'] == 1 and rep['markers'] >= 2
    t = src.read_text()
    for gone in ('SolidWorks', 'SwSTEP', 'naveen', 'Users', 'GOAT Robotics', 'Boss-Extrude', '3F2504E0', 'fileserver', 'T2CC', '_ISO'):
        assert gone not in t, gone
    assert "'Material','AISI 304'" in t, 'non-identifying properties stay (SW- prefix dropped)'
    assert 'plate.SLDPRT' in t, 'a path keeps only its file name'
    h = step_header(src)
    assert h.get('originating_system') == 'Forge' and not h.get('author')
    leaves = import_model(src)
    assert [l['name'] for l in leaves] == ['GT-SM-046-SMPS PLATE']
    from app.cad import analyze
    assert abs(analyze(leaves[0]['shape'], 'x')['volume'] - 600) < 1e-3
    # idempotent: a second pass changes nothing
    before = src.read_text().split('ENDSEC;', 1)[1]
    scrub(src)
    assert src.read_text().split('ENDSEC;', 1)[1] == before


def test_non_solidworks_names_are_left_alone(tmp_path):
    src = sw_step(tmp_path)
    t = src.read_text().replace('SolidWorks 2026', 'Creo 10').replace('SwSTEP 2.0', 'Creo STEP')
    src.write_text(t)
    out = tmp_path / 'o.step'
    rep = scrub_step(src, out)
    assert not rep['solidworks'] and rep['names'] == 0 and rep['bodies'] == 1
    assert '_ISO11GT-SM-046-SMPS PLATET2CC' in out.read_text() and 'Creo' not in out.read_text()


def test_iges_global_section_is_neutralised(tmp_path):
    from OCP.IGESControl import IGESControl_Writer, IGESControl_Reader
    w = IGESControl_Writer('MM', 1)
    w.AddShape(BRepPrimAPI_MakeBox(5, 5, 5).Shape())
    w.ComputeModel()
    p = tmp_path / 'source.igs'
    w.Write(str(p))
    t = p.read_text().splitlines()
    t[0] = 'SolidWorks IGES file using analytic representation for surfaces'.ljust(72) + 'S0000001'
    p.write_text('\n'.join(t) + '\n')
    rep = scrub(p)
    assert rep['header']
    txt = p.read_text()
    assert 'SolidWorks' not in txt and 'Open CASCADE' not in txt and 'Forge' in txt
    r = IGESControl_Reader()
    assert int(r.ReadFile(str(p))) == 1
    r.TransferRoots()
    assert not r.OneShape().IsNull()
