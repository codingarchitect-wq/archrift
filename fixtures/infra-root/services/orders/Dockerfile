FROM registry.example.com/gradle:8-jdk21 AS build
WORKDIR /src
COPY . .
RUN gradle bootJar

# the runtime image
FROM gcr.io/distroless/java21-debian12
COPY --from=build /src/build/libs/app.jar /app.jar
USER 65532
CMD ["/app.jar"]
