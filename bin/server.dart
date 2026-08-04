import 'dart:io';

import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;
import 'package:shelf_cors_headers/shelf_cors_headers.dart';

import 'package:llegue_backend/api.dart';
import 'package:llegue_backend/store.dart';

Future<void> main(List<String> args) async {
  final port = int.tryParse(Platform.environment['PORT'] ?? '') ?? 8787;
  final dataPath = Platform.environment['LLEGUE_DATA'] ??
      '${Directory.current.path}${Platform.pathSeparator}data${Platform.pathSeparator}store.json';

  final store = DataStore(File(dataPath));
  await store.load();

  final api = LlegueApi(store);
  final handler = Pipeline()
      .addMiddleware(logRequests())
      .addMiddleware(corsHeaders())
      .addHandler(api.handler);

  final server = await shelf_io.serve(handler, InternetAddress.anyIPv4, port);
  stdout.writeln('Llegué API escuchando en http://0.0.0.0:${server.port}');
  stdout.writeln('Datos: $dataPath');
  stdout.writeln('Health: http://localhost:${server.port}/health');
}
