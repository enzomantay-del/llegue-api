import 'dart:convert';
import 'dart:io';

import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';

import 'models.dart';
import 'store.dart';

class LlegueApi {
  LlegueApi(this.store);

  final DataStore store;

  /// Entrada principal: `/` muestra una página simple; el resto va al router.
  Handler get handler {
    final routes = router;
    return (Request request) {
      final path = request.url.path;
      if (request.method == 'GET' && (path.isEmpty || path == '/')) {
        return _homePage();
      }
      return routes.call(request);
    };
  }

  Response _homePage() {
    return Response.ok(
      '''
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Llegué API</title>
  <style>
    body { font-family: Georgia, serif; margin: 0; min-height: 100vh;
      background: linear-gradient(160deg, #e8f4ef, #f7f3eb); color: #1c2b28;
      display: grid; place-items: center; padding: 24px; }
    main { max-width: 420px; background: rgba(255,255,255,.8);
      border: 1px solid rgba(28,43,40,.08); border-radius: 20px; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 2rem; }
    p { margin: 0 0 12px; line-height: 1.45; color: #5c6f6a; }
    a { color: #146b56; font-weight: 700; }
    code { background: rgba(31,138,112,.12); padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <h1>Llegué</h1>
    <p>API del círculo familiar. Esta página es solo para comprobar que el servidor está vivo.</p>
    <p>Estado: <a href="/health"><code>/health</code></a></p>
    <p>En la app, usá esta URL en <strong>Familia → Servidor</strong>.</p>
  </main>
</body>
</html>
''',
      headers: {'content-type': 'text/html; charset=utf-8'},
    );
  }

  Router get router {
    final app = Router();

    app.get('/health', (Request request) {
      return _json({'ok': true, 'service': 'llegue-backend'});
    });

    /// Borra familias, miembros, eventos y rutinas del servidor (pruebas).
    app.post('/v1/admin/wipe', (Request request) async {
      final key = request.headers['x-admin-key'] ??
          request.url.queryParameters['key'];
      const expected = String.fromEnvironment(
        'LLEGUE_ADMIN_KEY',
        defaultValue: 'llegue-wipe-familia',
      );
      final envKey = Platform.environment['LLEGUE_ADMIN_KEY'] ?? expected;
      if (key != envKey) {
        return _error('No autorizado', status: 401);
      }
      await store.wipeAll();
      return _json({'ok': true, 'wiped': true});
    });

    app.post('/v1/families', (Request request) async {
      final body = await _body(request);
      final result = await store.createFamily(
        adminName: (body['name'] as String?) ?? 'Adulto',
        familyRole: (body['familyRole'] as String?) ?? 'Padre/Madre',
        birthDate: (body['birthDate'] as String?) ?? '',
        city: (body['city'] as String?) ?? '',
      );
      return _json(result, status: 201);
    });

    app.post('/v1/families/join', (Request request) async {
      final body = await _body(request);
      try {
        final result = await store.joinFamily(
          code: (body['code'] as String?) ?? '',
          name: (body['name'] as String?) ?? '',
          role: (body['role'] as String?) ?? 'adult',
        );
        return _json(result, status: 201);
      } catch (e) {
        return _error(e.toString().replaceFirst('Bad state: ', ''), status: 404);
      }
    });

    app.post('/v1/families/invites', (Request request) async {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      final body = await _body(request);
      try {
        final result = await store.createPendingInvite(
          actor: member,
          name: (body['name'] as String?) ?? '',
          role: (body['role'] as String?) ?? 'adult',
          familyRole: (body['familyRole'] as String?) ?? '',
          birthDate: (body['birthDate'] as String?) ?? '',
        );
        return _json(result, status: 201);
      } catch (e) {
        return _error(e.toString().replaceFirst('Bad state: ', ''), status: 403);
      }
    });

    app.get('/v1/invites/<token>', (Request request, String token) {
      final member = store.memberByInviteToken(token);
      if (member == null) {
        return _error('Invitación no encontrada', status: 404);
      }
      final family = store.families[member.familyId];
      return _json({
        'inviteToken': member.inviteToken,
        'name': member.name,
        'role': member.role,
        'familyRole': member.familyRole,
        'birthDate': member.birthDate,
        'pending': member.pending,
        'familyInviteCode': family?.inviteCode,
      });
    });

    app.post('/v1/families/join-invite', (Request request) async {
      final body = await _body(request);
      try {
        final result = await store.claimInvite(
          inviteToken: (body['inviteToken'] as String?) ?? '',
        );
        return _json(result, status: 201);
      } catch (e) {
        return _error(e.toString().replaceFirst('Bad state: ', ''), status: 404);
      }
    });

    app.get('/download', (Request request) {
      final token = request.url.queryParameters['t'] ??
          request.url.queryParameters['token'] ??
          '';
      if (token.trim().isNotEmpty) {
        return Response.found('/i/${Uri.encodeComponent(token.trim().toUpperCase())}');
      }
      return Response.ok(
        _downloadHtml(),
        headers: {'content-type': 'text/html; charset=utf-8'},
      );
    });

    app.get('/apk/Llegue.apk', (Request request) async {
      final file = _apkFile();
      if (file == null || !await file.exists()) {
        return Response.notFound(
          _downloadHtml(missingApk: true),
          headers: {'content-type': 'text/html; charset=utf-8'},
        );
      }
      final bytes = await file.readAsBytes();
      return Response.ok(
        bytes,
        headers: {
          'content-type': 'application/vnd.android.package-archive',
          'content-disposition': 'attachment; filename="Llegue.apk"',
          'content-length': '${bytes.length}',
        },
      );
    });

    app.get('/i/<token>', (Request request, String token) {
      final member = store.memberByInviteToken(token);
      if (member == null) {
        return Response.notFound(
          _inviteHtml(
            greeting: 'Este link ya no sirve',
            detail: 'Pedile a tu familia uno nuevo por WhatsApp.',
            token: '',
          ),
          headers: {'content-type': 'text/html; charset=utf-8'},
        );
      }
      final roleLabel = member.familyRole.isEmpty
          ? (member.role == 'child' ? 'Hijo/a' : 'Familiar')
          : member.familyRole;
      return Response.ok(
        _inviteHtml(
          greeting: 'Hola, ${member.name}',
          detail:
              'Te invitaron a la familia como $roleLabel. '
              'Tus datos ya están cargados. Solo descargá la app y entrá.',
          token: member.inviteToken,
        ),
        headers: {'content-type': 'text/html; charset=utf-8'},
      );
    });

    app.get('/v1/me', (Request request) {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      final family = store.families[member.familyId];
      if (family == null) return _error('Familia no encontrada', status: 404);
      return _json({
        'family': family.toJson(),
        'member': member.toPublicJson(),
        'members': store
            .membersOf(member.familyId)
            .map((m) => m.toPublicJson())
            .toList(),
      });
    });

    app.patch('/v1/me', (Request request) async {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      final body = await _body(request);
      if (body.containsKey('receivesAlerts') && member.role == 'adult') {
        member.receivesAlerts = body['receivesAlerts'] == true;
      }
      if (body['name'] is String && (body['name'] as String).trim().isNotEmpty) {
        // Name is final in model - recreate would be heavier; skip rename for now
      }
      await store.save();
      return _json({'member': member.toPublicJson()});
    });

    app.post('/v1/events', (Request request) async {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      final body = await _body(request);
      final event = await store.addEvent(
        actor: member,
        type: (body['type'] as String?) ?? 'info',
        title: (body['title'] as String?) ?? 'Aviso',
        body: (body['body'] as String?) ?? '',
        placeName: body['placeName'] as String?,
        latitude: (body['latitude'] as num?)?.toDouble(),
        longitude: (body['longitude'] as num?)?.toDouble(),
        highPriority: body['highPriority'] == true,
        childId: body['childId'] as String?,
        childName: body['childName'] as String?,
      );
      return _json({'event': event.toJson()}, status: 201);
    });

    app.get('/v1/events', (Request request) {
      final member = _auth(request);
      if (member == null) return _unauthorized();

      // Solo adultos con avisos activos reciben el feed (los hijos también pueden
      // leer para sync de UI, pero el cliente filtra).
      final sinceParam = request.url.queryParameters['since'];
      final since = DateTime.tryParse(sinceParam ?? '') ??
          DateTime.now().toUtc().subtract(const Duration(minutes: 30));

      final list = store.eventsSince(
        familyId: member.familyId,
        since: since,
        viewerMemberId: member.id,
      );

      return _json({'events': list.map((e) => e.toJson()).toList()});
    });

    app.get('/v1/config', (Request request) {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      return _json({'config': store.getConfig(member.familyId)});
    });

    app.put('/v1/config', (Request request) async {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      // Cualquier miembro del círculo puede actualizar la config compartida.
      final body = await _body(request);
      final places = body['places'] as List<dynamic>? ?? [];
      final routines = body['routines'] as List<dynamic>? ?? [];
      final children = body['children'] as List<dynamic>? ?? [];
      final config = await store.putConfig(
        familyId: member.familyId,
        places: places,
        routines: routines,
        children: children,
      );
      return _json({'config': config});
    });

    return app;
  }

  Member? _auth(Request request) {
    final header = request.headers['authorization'];
    if (header == null || !header.toLowerCase().startsWith('bearer ')) {
      return null;
    }
    final token = header.substring(7).trim();
    return store.membersByToken[token];
  }

  Future<Map<String, dynamic>> _body(Request request) async {
    final raw = await request.readAsString();
    if (raw.trim().isEmpty) return {};
    return Map<String, dynamic>.from(jsonDecode(raw) as Map);
  }

  Response _json(Object data, {int status = 200}) {
    return Response(
      status,
      body: jsonEncode(data),
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }

  Response _error(String message, {int status = 400}) {
    return _json({'error': message}, status: status);
  }

  Response _unauthorized() => _error('No autorizado', status: 401);

  File? _apkFile() {
    final candidates = [
      Platform.environment['LLEGUE_APK'],
      '${Directory.current.path}${Platform.pathSeparator}public${Platform.pathSeparator}Llegue.apk',
      '/app/public/Llegue.apk',
    ];
    for (final path in candidates) {
      if (path == null || path.isEmpty) continue;
      final f = File(path);
      if (f.existsSync()) return f;
    }
    return null;
  }

  String _downloadHtml({bool missingApk = false}) {
    final hasApk = !missingApk && _apkFile() != null;
    final button = hasApk
        ? '<a class="btn" href="/apk/Llegue.apk">Descargar Llegué</a>'
        : '<p class="warn">La descarga se está preparando. Pedile a tu familia el archivo por WhatsApp.</p>';
    return '''
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Descargar Llegué</title>
  <style>
    body { font-family: "Segoe UI", system-ui, sans-serif; margin: 0; min-height: 100vh;
      background: linear-gradient(155deg, #0f3d34, #1f8a70 55%, #3d2a1a); color: #fff;
      display: grid; place-items: center; padding: 24px; }
    main { max-width: 420px; width: 100%; background: rgba(255,255,255,.12);
      border: 1px solid rgba(255,255,255,.18); border-radius: 24px; padding: 28px; }
    h1 { font-family: Georgia, serif; margin: 0 0 10px; font-size: 2rem; }
    p { margin: 0 0 14px; line-height: 1.45; color: rgba(255,255,255,.86); }
    .btn { display: block; text-align: center; text-decoration: none; color: #0f3d34;
      background: #fff; font-weight: 800; padding: 18px; border-radius: 16px; margin-top: 18px; font-size: 1.1rem; }
    .warn { background: rgba(225,90,79,.25); padding: 12px; border-radius: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>Llegué</h1>
    <p>App para que la familia sepa cuando llegás.</p>
    $button
  </main>
</body>
</html>
''';
  }

  String _inviteHtml({
    required String greeting,
    required String detail,
    required String token,
  }) {
    final hasToken = token.isNotEmpty;
    final downloadBtn = hasToken
        ? '<a class="btn" href="/apk/Llegue.apk">1. Descargar Llegué</a>'
        : '';
    final openBtn = hasToken
        ? '<a class="btn secondary" href="llegue://join/$token">2. Ya la instalé — Entrar</a>'
        : '';
    final tip = hasToken
        ? '<p class="tip">Si “Entrar” no abre la app, abrí Llegué y tocá <strong>Me invitaron</strong>. Pegá este mismo link de WhatsApp.</p>'
        : '';
    return '''
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Llegué</title>
  <style>
    body { font-family: "Segoe UI", system-ui, sans-serif; margin: 0; min-height: 100vh;
      background: linear-gradient(155deg, #0f3d34, #1f8a70 55%, #3d2a1a); color: #fff;
      display: grid; place-items: center; padding: 24px; }
    main { max-width: 420px; width: 100%; background: rgba(255,255,255,.12);
      border: 1px solid rgba(255,255,255,.18); border-radius: 24px; padding: 28px; }
    h1 { font-family: Georgia, serif; margin: 0 0 8px; font-size: 2rem; }
    .hi { font-size: 1.35rem; font-weight: 700; margin: 0 0 10px; color: #fff; }
    p { margin: 0 0 12px; line-height: 1.45; color: rgba(255,255,255,.86); }
    .btn { display: block; text-align: center; text-decoration: none; color: #0f3d34;
      background: #fff; font-weight: 800; padding: 18px; border-radius: 16px;
      margin: 14px 0 0; font-size: 1.05rem; }
    .btn.secondary { background: rgba(255,255,255,.18); color: #fff;
      border: 2px solid rgba(255,255,255,.55); }
    .tip { margin-top: 18px; font-size: .95rem; color: rgba(255,255,255,.75); }
  </style>
</head>
<body>
  <main>
    <h1>Llegué</h1>
    <p class="hi">$greeting</p>
    <p>$detail</p>
    $downloadBtn
    $openBtn
    $tip
  </main>
</body>
</html>
''';
  }
}
