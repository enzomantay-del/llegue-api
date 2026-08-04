import 'dart:convert';

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

    app.post('/v1/families', (Request request) async {
      final body = await _body(request);
      final result = await store.createFamily(
        adminName: (body['name'] as String?) ?? 'Adulto',
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
}
