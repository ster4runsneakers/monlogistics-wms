import http.server
import socketserver
import sys

PORT = 8000

class QuietHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write("%s - - [%s] %s\n" %
                         (self.address_string(),
                          self.log_date_time_string(),
                          format%args))

if __name__ == "__main__":
    Handler = QuietHTTPRequestHandler
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"MonLogistics WMS Server running on http://localhost:{PORT}")
        httpd.serve_forever()
